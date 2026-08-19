import Cairo from 'gi://cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Weather from 'resource:///org/gnome/shell/misc/weather.js';
let Me;

const CALENDAR_FILE = 'org.gnome.Calendar.desktop';
const CLOCKS_FILE = 'org.gnome.clocks.desktop';
const WEATHER_FILE = 'org.gnome.Weather.desktop';

let weatherClient, weatherTimeout;

async function createWeatherClient() {
    weatherClient = new Weather.WeatherClient();
    cachedTemperatureUnit = await getGnomeTemperatureUnitAsync();
    weatherTimeout = GLib.timeout_add_seconds(0, 30, () => {
        weatherClient.info.update();
        refreshTemperatureUnit();
        // Covers the case where the weather app (Flatpak) wasn't installed
        // yet when we enabled - there was no keyfile to watch back then, so
        // pick it up here once it exists instead of staying on this poll
        // forever.
        if (!tempUnitMonitor) {
            watchFlatpakKeyfile();
        }
        return true;
    });
    if (weatherClient) {
        weatherClient.emit('changed');
    }
}

// Re-checks the unit and repaints if it changed. Gets called from the
// keyfile/GSettings watchers below, plus every 30s just in case we missed one.
async function refreshTemperatureUnit() {
    const newUnit = await getGnomeTemperatureUnitAsync();
    if (newUnit !== cachedTemperatureUnit) {
        cachedTemperatureUnit = newUnit;
        if (weatherClient && weatherClient.info) {
            weatherClient.info.update();
        }
        if (weatherClient) {
            weatherClient.emit('changed');
        }
    }
}

// Path to Flatpak keyfile
function getWeatherSettingsKeyfilePath() {
    return GLib.build_filenamev([
        GLib.get_home_dir(),
        '.var', 'app', 'org.gnome.Weather', 'config', 'glib-2.0', 'settings', 'keyfile'
    ]);
}

// Returns the GNOME Weather temperature unit setting as a string ('celsius', 'centigrade', or 'fahrenheit')
async function getGnomeTemperatureUnitAsync() {
    const keyfilePath = getWeatherSettingsKeyfilePath();
    const file = Gio.File.new_for_path(keyfilePath);

    if (file.query_exists(null)) {
        const [contents] = await file.load_contents_async(null);
        const text = new TextDecoder('utf-8').decode(contents);
        const match = text.match(/temperature-unit\s*=\s*'?(celsius|centigrade|fahrenheit)'?/i);
        if (match && match[1])
            return match[1].toLowerCase();
    }

    if (Gio.Settings.list_schemas().includes('org.gnome.GWeather4')) {
        const gwSettings = new Gio.Settings({ schema: 'org.gnome.GWeather4' });
        const unit = gwSettings.get_string('temperature-unit');
        if (unit === 'centigrade' || unit === 'celsius')
            return 'celsius';
        if (unit === 'fahrenheit')
            return 'fahrenheit';
    }

    return 'default';
}

let settings, textureHandler, handlers = [];
let desktopInterfaceSettings;
let tempUnitMonitor = null;
let gwSettingsMonitor = null, gwSettingsHandler = null;
let cachedTemperatureUnit = 'default';
let enableCalendar, showWeekday, showMonth, enableClocks, showSeconds;
let enableWeather, showBackground, showTemperature, enableDigitalClock;

function loadSettings() {
    settings = Me.getSettings('org.gnome.shell.extensions.dynamic-calendar-and-clocks-icons-reborn');
    desktopInterfaceSettings = Me.getSettings('org.gnome.desktop.interface');
    loadTheme();
    enableCalendar = settings.get_boolean('calendar');
    showWeekday = settings.get_boolean('show-weekday');
    showMonth = settings.get_boolean('show-month');
    enableClocks = settings.get_boolean('clocks');
    enableDigitalClock = settings.get_boolean('digital-clock');
    showSeconds = settings.get_boolean('show-seconds');
    enableWeather = settings.get_boolean('weather');
    showBackground = settings.get_boolean('show-background');
    showTemperature = settings.get_boolean('show-temperature');
    let textureCache = St.TextureCache.get_default();
    textureHandler = textureCache.connect('icon-theme-changed', () => {
        loadTheme();
        weatherClient.emit('changed');
    });
    handlers.push(settings.connect('changed::theme', () => {
        loadTheme();
        weatherClient.emit('changed');
    }));
    handlers.push(settings.connect('changed::calendar', () => {
        enableCalendar = settings.get_boolean('calendar');
        redisplayIcons();
    }));
    handlers.push(settings.connect('changed::show-weekday', () => {
        showWeekday = settings.get_boolean('show-weekday');
    }));
    handlers.push(settings.connect('changed::show-month', () => {
        showMonth = settings.get_boolean('show-month');
    }));
    handlers.push(settings.connect('changed::clocks', () => {
        enableClocks = settings.get_boolean('clocks');
        redisplayIcons();
    }));
    handlers.push(settings.connect('changed::digital-clock', () => {
        enableDigitalClock = settings.get_boolean('digital-clock');
        redisplayIcons();
    }));
    handlers.push(settings.connect('changed::show-seconds', () => {
        showSeconds = settings.get_boolean('show-seconds');
    }));
    handlers.push(settings.connect('changed::weather', () => {
        enableWeather = settings.get_boolean('weather');
        redisplayIcons();
    }));
    handlers.push(settings.connect('changed::show-background', () => {
        showBackground = settings.get_boolean('show-background');
        redisplayIcons();
    }));
    handlers.push(settings.connect('changed::show-temperature', () => {
        showTemperature = settings.get_boolean('show-temperature');
        weatherClient.emit('changed');
    }));
}

// Watch for temperature unit changes - Flatpak keyfile or GSettings,
// whichever one applies. Just for a quick response; the 30s poll in
// createWeatherClient() catches it either way if we miss an event here.
function createTemperatureUnitMonitor() {
    // Flatpak GNOME Weather: watch the keyfile if it exists.
    watchFlatpakKeyfile();

    // Distro-packaged GNOME Weather: watch the GSettings key
    // directly, since there's no keyfile to monitor in this case.
    if (Gio.Settings.list_schemas().includes('org.gnome.GWeather4')) {
        gwSettingsMonitor = new Gio.Settings({ schema: 'org.gnome.GWeather4' });
        gwSettingsHandler = gwSettingsMonitor.connect('changed::temperature-unit', () => {
            refreshTemperatureUnit();
        });
    }
}

function watchFlatpakKeyfile() {
    const keyfilePath = getWeatherSettingsKeyfilePath();
    const keyfile = Gio.File.new_for_path(keyfilePath);
    if (!keyfile.query_exists(null)) {
        return;
    }
 
    const monitor = keyfile.monitor_file(Gio.FileMonitorFlags.NONE, null);
    if (!monitor) {
        return;
    }
 
    tempUnitMonitor = monitor;
    tempUnitMonitor.handlerId = tempUnitMonitor.connect('changed', () => {
        refreshTemperatureUnit();
        teardownFlatpakKeyfileWatch();
        watchFlatpakKeyfile();
    });
}

// Helper function to destroy Flatpak keyfile watcher
function teardownFlatpakKeyfileWatch() {
    if (tempUnitMonitor) {
        if (tempUnitMonitor.handlerId) {
            tempUnitMonitor.disconnect(tempUnitMonitor.handlerId);
        }
        tempUnitMonitor.cancel();
        tempUnitMonitor = null;
    }
}

let path, themeData, stylesheetFile;

async function loadTheme() {
    let theme = settings.get_string('theme');
    path = Me.path + '/themes/' + theme;
    if (!theme || !Gio.File.new_for_path(path).query_exists(null)) {
        let interfaceSettings = Me.getSettings('org.gnome.desktop.interface');
        theme = interfaceSettings.get_string('icon-theme');
        path = Me.path + '/themes/' + theme;
        if (!theme || !Gio.File.new_for_path(path).query_exists(null)) {
            path = Me.path + '/themes/Adwaita';
        }
    }
    path += '/';

    let jsonFile = Gio.File.new_for_path(path + 'theme-data.json');
    let [json] = await jsonFile.load_contents_async(null);
    themeData = JSON.parse(new TextDecoder('utf-8').decode(json));

    let context = St.ThemeContext.get_for_stage(global.stage);
    if (stylesheetFile) {
        context.get_theme().unload_stylesheet(stylesheetFile);
    }
    stylesheetFile = Gio.File.new_for_path(path + 'stylesheet.css');
    context.get_theme().load_stylesheet(stylesheetFile);
    loadSurfaces();
}

let calendar, calendar48, symbolicCalendar, clocks, symbolicClocks;
let hour, symbolicHour, minute, symbolicMinute, second;

function loadSurfaces() {
    calendar = loadSurface('calendar.png');
    calendar48 = loadOptionalSurface('calendar-48.png');
    symbolicCalendar = loadSurface('calendar-symbolic.png');
    clocks = loadSurface('clocks.png');
    symbolicClocks = loadSurface('clocks-symbolic.png');
    hour = loadSurface('hour.png');
    symbolicHour = loadSurface('hour-symbolic.png');
    minute = loadSurface('minute.png');
    symbolicMinute = loadSurface('minute-symbolic.png');
    second = loadSurface('second.png');
}

function loadSurface(file) {
    return Cairo.ImageSurface.createFromPNG(path + file);
}

function loadOptionalSurface(file) {
    let filePath = path + file;
    if(!Gio.File.new_for_path(filePath).query_exists(null)) {
        return null;
    }
    return Cairo.ImageSurface.createFromPNG(filePath);
}

let originalCreate;

function createIconTexture(iconSize) {
    if(enableCalendar && this.get_id() == CALENDAR_FILE) {
        return newIcon(iconSize, 'calendar', repaintCalendar);
    }
    if(enableClocks && this.get_id() == CLOCKS_FILE) {
        return newIcon(iconSize, 'clocks', repaintClocks);
    }
    if(enableWeather && this.get_id() == WEATHER_FILE) {
        return newWeatherIcon(iconSize);
    }
    return originalCreate.call(this, iconSize);
}

let calendarClocksIcons = [];

function newIcon(iconSize, name, repaintFunc) {
    let icon = new St.DrawingArea();
    icon.timeout = GLib.timeout_add_seconds(0, 1, () => {
        icon.queue_repaint();
        return true;
    });
    icon.requestedIconSize = iconSize;
    if(iconSize != -1) {
        let context = St.ThemeContext.get_for_stage(global.stage);
        iconSize *= context.scale_factor;
    }
    icon.scaledIconSize = iconSize;
    icon.set_size(iconSize, iconSize);
    icon.set_name('dynamic-' + name + '-icon');
    icon.handler = icon.connect('repaint', repaintFunc);
    icon.queue_repaint();
    addIconToArray(icon, disposeIcon, calendarClocksIcons);
    return icon;
}

let weatherIcons = [];

function newWeatherIcon(iconSize) {
    if(!showBackground) {
        return newWeatherIconWithoutBackground(iconSize);
    }
    let icon = new St.Bin({y_align: 2});
    icon.handler = weatherClient.connect('changed', () => {
        repaintWeather(icon);
    });
    icon.requestedIconSize = iconSize;
    if(iconSize != -1) {
        let context = St.ThemeContext.get_for_stage(global.stage);
        iconSize *= context.scale_factor;
    }
    icon.set_size(iconSize, iconSize);
    icon.set_name('dynamic-weather-icon');
    icon.boxLayout = new St.BoxLayout({vertical: true, y_expand: true});
    icon.set_child(icon.boxLayout);
    icon.image = new St.Icon({x_align: 2});
    icon.boxLayout.add_child(icon.image);
    icon.label = new St.Label({x_align: 2});
    icon.boxLayout.add_child(icon.label);
    icon.timeout = GLib.timeout_add(0, 0, () => {
        repaintWeather(icon);
        icon.timeout = null;
        return false;
    });
    addIconToArray(icon, disposeWeatherIcon, weatherIcons);
    return icon;
}

function newWeatherIconWithoutBackground(iconSize) {
    let icon = new St.Icon();
    icon.handler = weatherClient.connect('changed', () => {
        repaintWeatherWithoutBackground(icon);
    });
    icon.set_icon_size(iconSize);
    icon.timeout = GLib.timeout_add(0, 0, () => {
        repaintWeatherWithoutBackground(icon);
        icon.timeout = null;
        return false;
    });
    addIconToArray(icon, disposeWeatherIcon, weatherIcons);
    return icon;
}

function disposeIcon(icon) {
    GLib.source_remove(icon.timeout);
    icon.disconnect(icon.handler);
    icon.disconnect(icon.stageViewsChangedHandler);
    icon.disconnect(icon.destroyHandler);
}

function disposeWeatherIcon(icon) {
    if(icon.timeout != null) {
        GLib.source_remove(icon.timeout);
    }
    weatherClient.disconnect(icon.handler);
    icon.disconnect(icon.stageViewsChangedHandler);
    icon.disconnect(icon.destroyHandler);
}

function addIconToArray(icon, disposeFunc, array) {
    icon.stageViewsChangedHandler =
    icon.connect('stage-views-changed', () => {
        if(icon.get_stage() == null
        && !(icon.has_style_class_name('icon-dropshadow')
        && icon.requestedIconSize == 32)) {
            icon.destroy();
        }
    });
    icon.destroyHandler = icon.connect('destroy', () => {
        disposeFunc(icon);
        array.splice(array.indexOf(icon), 1);
    });
    array.push(icon);
}

function calculateDateOffset(iconSize, date) {
        const unit = iconSize / 48;
        const numOnes = date.split('1').length - 1;
        return unit * numOnes / date.length;
}

function repaintCalendar(icon) {
    if(icon.get_stage() == null) return;
    if(icon.get_theme_node().get_icon_style() == 2) {
        repaintSymbolicCalendar(icon);
        return;
    }
    let now = new Date();
    let locale = GLib.getenv('LC_TIME');
    if(locale != null) {
        locale = [locale.split('.')[0].replace('_', '-'), 'default'];
    } else {
        locale = 'default';
    }
    let day = now.toLocaleString(locale, {weekday: 'short'});
    let month = now.toLocaleString(locale, {month: 'short'});
    let date = now.getDate().toString();
    let dayMonthR = themeData.dayMonthColor[0] / 255;
    let dayMonthG = themeData.dayMonthColor[1] / 255;
    let dayMonthB = themeData.dayMonthColor[2] / 255;
    let dayMonthBold = themeData.dayMonthBold ? ' bold' : '';
    let {dayMonthFont, dayMonthSize, dayMonthPos} = themeData;
    let dateR = themeData.dateColor[0] / 255;
    let dateG = themeData.dateColor[1] / 255;
    let dateB = themeData.dateColor[2] / 255;
    let dateBold = themeData.dateBold ? 1 : 0;
    let {dateFont, dateSize, datePos, dateOnlyPos} = themeData;
    let context = icon.get_context();
    let iconSize = getIconSize(icon, context);
    let calendarBackground = calendar;
    let calendarBackgroundSize = 512;
    let requestedSize = icon.requestedIconSize;
    if(requestedSize == -1) {
        let themeContext = St.ThemeContext.get_for_stage(global.stage);
        requestedSize = iconSize / themeContext.scale_factor;
    }
    if(requestedSize <= 48 && calendar48 != null) {
        calendarBackground = calendar48;
        calendarBackgroundSize = 96;
    }
    let scaleFactor = iconSize / calendarBackgroundSize;
    context.scale(scaleFactor, scaleFactor);
    context.setSourceSurface(calendarBackground, 0, 0);
    context.paint();
    scaleFactor = 1 / scaleFactor;
    context.scale(scaleFactor, scaleFactor);
    context.setSourceRGB(dayMonthR, dayMonthG, dayMonthB);
    let layout = PangoCairo.create_layout(context);
    let fontFace = dayMonthFont + ', sans-serif' + dayMonthBold;
    let fontSize = iconSize / 96 * dayMonthSize;
    let text;
    if(showWeekday) {
        text = showMonth ? day + ' ' + month : day;
    } else {
        text = showMonth ? month : '';
    }
    let maxWidth = iconSize / 96 * themeData.dayMonthMaxWidth;
    do {
        let desc = ' font_desc="' + fontFace + ' ' + fontSize + 'px"';
        layout.set_markup('<span' + desc + '>' + text + '</span>', -1);
        fontSize -= iconSize / 96;
    } while(layout.get_pixel_size()[0] > maxWidth && fontSize > 0);
    let textX = (iconSize - layout.get_pixel_size()[0]) / 2;
    let baseline = layout.get_baseline() / Pango.SCALE;
    context.moveTo(textX, iconSize / 96 * dayMonthPos - baseline);
    PangoCairo.show_layout(context, layout);

    context.setSourceRGB(dateR, dateG, dateB);

    let dateLayout = PangoCairo.create_layout(context);
    let dateDesc = ' font_desc="' + dateFont + (dateBold ? ' bold' : '') + ' ' + (iconSize / 96 * dateSize) + 'px"';
    dateLayout.set_markup('<span' + dateDesc + '>' + date + '</span>', -1);

    let horizOffset = themeData.dateHorizontalOffset !== undefined ? themeData.dateHorizontalOffset : 0;

    let dateX = ((iconSize - dateLayout.get_pixel_size()[0]) / 2) + (iconSize / 96 * horizOffset);

    datePos = showWeekday || showMonth ? datePos : dateOnlyPos;
    let dateBaseline = dateLayout.get_baseline() / Pango.SCALE;

    context.moveTo(dateX, iconSize / 96 * datePos - dateBaseline);
    PangoCairo.show_layout(context, dateLayout);

    context.$dispose();
}

function repaintSymbolicCalendar(icon) {
    let now = new Date();
    let date = now.getDate().toString();
    let symDateR = themeData.symDateColor[0] / 255;
    let symDateG = themeData.symDateColor[1] / 255;
    let symDateB = themeData.symDateColor[2] / 255;
    let symDateBold = themeData.symDateBold ? 1 : 0;
    let {symDateFont, symDateSize, symDatePos} = themeData;
    let context = icon.get_context();
    let iconSize = getIconSize(icon, context);
    let scaleFactor = iconSize / 128;
    context.scale(scaleFactor, scaleFactor);
    context.setSourceSurface(symbolicCalendar, 0, 0);
    context.paint();
    scaleFactor = 1 / scaleFactor;
    context.scale(scaleFactor, scaleFactor);
    if(themeData.symDateDestOut) {
        context.setOperator(Cairo.Operator.DEST_OUT);
    }
    context.setSourceRGB(symDateR, symDateG, symDateB);

    let dateLayout = PangoCairo.create_layout(context);
    let dateDesc = ' font_desc="' + symDateFont + (symDateBold ? ' bold' : '') + ' ' + (iconSize / 16 * symDateSize) + 'px"';
    dateLayout.set_markup('<span' + dateDesc + '>' + date + '</span>', -1);

    let dateX = (iconSize - dateLayout.get_pixel_size()[0]) / 2;
    let dateBaseline = dateLayout.get_baseline() / Pango.SCALE;

    context.moveTo(dateX, iconSize / 16 * symDatePos - dateBaseline);
    PangoCairo.show_layout(context, dateLayout);
    context.$dispose();
}

function repaintClocks(icon) {
    if(icon.get_stage() == null) return;
    if(icon.get_theme_node().get_icon_style() == 2) {
        // Symbolic style still uses the analog face for now - digital
        // mode only replaces the full-color icon.
        repaintSymbolicClocks(icon);
        return;
    }
    if(enableDigitalClock) {
        repaintDigitalClock(icon);
        return;
    }
    let now = new Date();
    let hours = now.getHours() % 12;
    let minutes = now.getMinutes();
    let seconds = now.getSeconds();
    let clockCenter = themeData.clockCenter / 96 * 512;
    let context = icon.get_context();
    let scaleFactor = getIconSize(icon, context) / 512;
    context.scale(scaleFactor, scaleFactor);
    context.setSourceSurface(clocks, 0, 0);
    context.paint();
    context.translate(256, clockCenter);
    let hourAngle = (hours + minutes / 60) * 30 * Math.PI / 180;
    context.rotate(hourAngle);
    context.translate(-256, -clockCenter);
    context.setSourceSurface(hour, 0, 0);
    context.paint();
    context.translate(256, clockCenter);
    let minuteAngle = (minutes + seconds / 60) * 6 * Math.PI / 180;
    context.rotate(minuteAngle - hourAngle);
    context.translate(-256, -clockCenter);
    context.setSourceSurface(minute, 0, 0);
    context.paint();
    if(showSeconds) {
        context.translate(256, clockCenter);
        context.rotate(seconds * 6 * Math.PI / 180 - minuteAngle);
        context.translate(-256, -clockCenter);
        context.setSourceSurface(second, 0, 0);
        context.paint();
    }
    context.$dispose();
}

function repaintSymbolicClocks(icon) {
    let now = new Date();
    let hours = now.getHours() % 12;
    let minutes = now.getMinutes();
    let symClockCenter = themeData.symClockCenter * 8;
    let context = icon.get_context();
    let scaleFactor = getIconSize(icon, context) / 128;
    context.scale(scaleFactor, scaleFactor);
    context.setSourceSurface(symbolicClocks, 0, 0);
    context.paint();
    if(themeData.symClockDestOut) {
        context.setOperator(Cairo.Operator.DEST_OUT);
    }
    context.translate(64, symClockCenter);
    let hourAngle = (hours + minutes / 60) * 30 * Math.PI / 180;
    context.rotate(hourAngle);
    context.translate(-64, -symClockCenter);
    context.setSourceSurface(symbolicHour, 0, 0);
    context.paint();
    context.translate(64, symClockCenter);
    context.rotate(minutes * 6 * Math.PI / 180 - hourAngle);
    context.translate(-64, -symClockCenter);
    context.setSourceSurface(symbolicMinute, 0, 0);
    context.paint();
    context.$dispose();
}

// Standard rounded-rect path, built from four quarter arcs.
function roundedRectPath(context, x, y, w, h, r) {
    context.newSubPath();
    context.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    context.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    context.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    context.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    context.closePath();
}

// Draws one flip-card. Real gap between the two flaps, not just a painted
// line - a thin line gets lost once this 512px design scales down to a
// real ~32-96px icon. Digits get drawn once per flap, clipped to each
// half, so the number itself splits at the seam too.
function drawFlipCard(context, x, y, w, h, text) {
    const gap = 6; // physical gap between flaps, in 512px design space

    // Fill behind everything so the gap between flaps shows this color
    // instead of nothing.
    roundedRectPath(context, x, y, w, h, 10);
    context.setSourceRGB(0.02, 0.02, 0.02);
    context.fillPreserve();
    context.setSourceRGBA(0.4, 0.4, 0.42, 0.9);
    context.setLineWidth(2.5);
    context.stroke();

    let halfH = (h - gap) / 2;
    let topRect = [x, y, w, halfH];
    let bottomRect = [x, y + halfH + gap, w, halfH];

    // Build the layout once and reuse it for both flaps so they line up.
    let layout = PangoCairo.create_layout(context);
    // Stops glyphs from snapping to the pixel grid - without this the
    // digits drift at small icon sizes. Guarded since it's Pango 1.44+.
    let pangoContext = layout.get_context();
    if(typeof pangoContext.set_round_glyph_positions === 'function') {
        pangoContext.set_round_glyph_positions(false);
    }
    let fontSize = 150;
    let inkRect, logicalRect;
    do {
        layout.set_markup('<span font_desc="Sans Bold ' + fontSize + 'px">' + text + '</span>', -1);
        [inkRect, logicalRect] = layout.get_pixel_extents();
        fontSize -= 4;
    } while(logicalRect.width > w - 16 && fontSize > 20);

    // Use ink extents, not logical - logical height includes descender
    // space digits don't use, which was pushing them off-center.
    let textX = x + (w - inkRect.width) / 2 - inkRect.x;
    let textY = (y + h / 2 - inkRect.height / 2) - inkRect.y;

    // Top flap - clip to the card shape plus the top half, so only that
    // half of the flap and digit shows.
    context.save();
    roundedRectPath(context, x, y, w, h, 10);
    context.clip();
    context.rectangle(...topRect);
    context.clip();
    context.setSourceRGB(0.17, 0.17, 0.19);
    context.rectangle(...topRect);
    context.fill();
    context.setSourceRGB(0.83, 0.77, 0.63);
    context.moveTo(textX, textY);
    PangoCairo.show_layout(context, layout);
    context.restore();

    // Bottom flap, same deal but clipped to the bottom half.
    context.save();
    roundedRectPath(context, x, y, w, h, 10);
    context.clip();
    context.rectangle(...bottomRect);
    context.clip();
    context.setSourceRGB(0.17, 0.17, 0.19);
    context.rectangle(...bottomRect);
    context.fill();
    context.setSourceRGB(0.83, 0.77, 0.63);
    context.moveTo(textX, textY);
    PangoCairo.show_layout(context, layout);
    context.restore();

    // Stroke the border again on top so it stays crisp
    roundedRectPath(context, x, y, w, h, 10);
    context.setSourceRGBA(0.4, 0.4, 0.42, 0.9);
    context.setLineWidth(2);
    context.stroke();
}

// Flip-clock face, drawn entirely with Cairo in the same 512x512 space
// repaintClocks uses for the analog face. No theme assets needed - every
// icon theme gets the same digital face for now.
function repaintDigitalClock(icon) {
    if(icon.get_stage() == null) return;
    let now = new Date();
    let context = icon.get_context();
    let scaleFactor = getIconSize(icon, context) / 512;
    context.scale(scaleFactor, scaleFactor);

    // Metal bezel
    roundedRectPath(context, 40, 40, 432, 432, 48);
    context.setSourceRGB(0.27, 0.27, 0.29);
    context.fillPreserve();
    context.setSourceRGB(0.5, 0.5, 0.52);
    context.setLineWidth(4);
    context.stroke();

    // Top sheen
    context.save();
    roundedRectPath(context, 40, 40, 432, 432, 48);
    context.clip();
    context.setSourceRGBA(1, 1, 1, 0.08);
    context.rectangle(40, 40, 432, 40);
    context.fill();
    context.restore();

    // Display window, drawn before the screws so it can't paint over them.
    roundedRectPath(context, 72, 72, 368, 368, 16);
    context.setSourceRGB(0.06, 0.06, 0.07);
    context.fill();

    // Corner screws, tucked inside the window's own corners, clear of the
    // cards (y=166..346).
    context.setSourceRGB(0.55, 0.55, 0.57);
    for (const [cx, cy] of [[96, 96], [416, 96], [96, 416], [416, 416]]) {
        context.arc(cx, cy, 8, 0, 2 * Math.PI);
        context.fill();
    }

    // HH : MM flip cards - hour format follows GNOME's clock-format
    // setting, same as the analog clock face would if it showed a digit.
    let use12h = desktopInterfaceSettings.get_string('clock-format') === '12h';
    let hours24 = now.getHours();
    let meridiem = hours24 >= 12 ? 'PM' : 'AM';
    let hourValue = use12h ? (hours24 % 12 || 12) : hours24;
    let hourStr = String(hourValue).padStart(2, '0');
    let minuteStr = String(now.getMinutes()).padStart(2, '0');
    let seconds = now.getSeconds();
    let cardWidth = 150, cardHeight = 180, cardY = 166;
    let card1X = 86, colonX = 236, card2X = 276;

    drawFlipCard(context, card1X, cardY, cardWidth, cardHeight, hourStr);
    drawFlipCard(context, card2X, cardY, cardWidth, cardHeight, minuteStr);

    if(use12h) {
        context.setSourceRGB(0.83, 0.77, 0.63);
        let meridiemLayout = PangoCairo.create_layout(context);
        meridiemLayout.set_markup('<span font_desc="Sans Bold 44px">' + meridiem + '</span>', -1);
        let [meridiemInk] = meridiemLayout.get_pixel_extents();
        let meridiemX = 256 - meridiemInk.width / 2 - meridiemInk.x;
        let meridiemY = 384 - meridiemInk.height / 2 - meridiemInk.y;
        context.moveTo(meridiemX, meridiemY);
        PangoCairo.show_layout(context, meridiemLayout);
    }

    // Colon blinks with real seconds when Show Seconds is on, otherwise
    // just stays solid.
    let colonAlpha = showSeconds ? (seconds % 2 === 0 ? 1 : 0.15) : 1;
    context.setSourceRGBA(0.83, 0.77, 0.63, colonAlpha);
    let colonCenterX = colonX + 20;
    for (const cy of [cardY + cardHeight * 0.32, cardY + cardHeight * 0.68]) {
        context.arc(colonCenterX, cy, 11, 0, 2 * Math.PI);
        context.fill();
    }

    context.$dispose();
}

function repaintWeather(icon) {
    if(icon.get_stage() == null) return;
    if(icon.get_theme_node().get_icon_style() == 2) {
        repaintSymbolicWeather(icon);
        return;
    }
    let forecast = getForecast();
    let iconName = 'weather-none', temperature = ' --°';
    if(forecast != null) {
        iconName = forecast.get_icon_name();
        let unit = cachedTemperatureUnit;
        let tempValue;
        if (unit === 'fahrenheit') {
            [, tempValue] = forecast.get_value_temp(4);
        } else if (unit === 'celsius' || unit === 'centigrade') {
            [, tempValue] = forecast.get_value_temp(3);
        } else {
            [, tempValue] = forecast.get_value_temp(1);
        }
        let prefix = Math.round(tempValue) >= 0 ? ' ' : '';
        temperature = prefix + Math.round(tempValue) + '°';
    }
    let {weatherSize, weatherPos, weatherOnlyPos} = themeData;
    let tempR = themeData.temperatureColor[0];
    let tempG = themeData.temperatureColor[1];
    let tempB = themeData.temperatureColor[2];
    let tempBold = themeData.temperatureBold ? 'bold' : 'normal';
    let {temperatureFont, temperatureSize} = themeData;
    let iconSize = icon.requestedIconSize;
    weatherPos = showTemperature ? weatherPos : weatherOnlyPos;
    icon.boxLayout.style =
    'padding-top: ' + iconSize / 96 * weatherPos + 'px;' +
    'background-image: url(' + path + 'weather.svg);' +
    'background-size: ' + iconSize + 'px;';
    icon.image.set_gicon(getWeatherImage(iconName));
    icon.image.set_icon_size(iconSize / 96 * weatherSize);
    icon.label.set_text(temperature);
    icon.label.set_text_direction(1);
    icon.label.style =
    'color: rgb(' + tempR + ',' + tempG + ',' + tempB + ');' +
    'font-family: ' + temperatureFont + ', sans-serif;' +
    'font-weight: ' + tempBold + ';' +
    'font-size: ' + iconSize / 96 * temperatureSize + 'px;' +
    'text-shadow: 0 0 transparent;';
    icon.label.visible = showTemperature;
}

function repaintSymbolicWeather(icon) {
    let forecast = getForecast();
    let iconName = 'weather-none-symbolic';
    if(forecast != null) {
        iconName = forecast.get_symbolic_icon_name();
    }
    icon.image.set_gicon(getWeatherImage(iconName));
    icon.image.set_icon_size(icon.requestedIconSize);
    icon.label.visible = false;
}

function repaintWeatherWithoutBackground(icon) {
    if(icon.get_stage() == null) return;
    if(icon.get_theme_node().get_icon_style() == 2) {
        repaintSymbolicWeatherWithoutBackground(icon);
        return;
    }
    let forecast = getForecast();
    let iconName = 'weather-none';
    if(forecast != null) {
        iconName = forecast.get_icon_name();
    }
    icon.set_gicon(getWeatherImage(iconName));
}

function repaintSymbolicWeatherWithoutBackground(icon) {
    let forecast = getForecast();
    let iconName = 'weather-none-symbolic';
    if(forecast != null) {
        iconName = forecast.get_symbolic_icon_name();
    }
    icon.set_gicon(getWeatherImage(iconName));
}

function getForecast() {
    if(!weatherClient.available || !weatherClient.hasLocation
    || !weatherClient.info.is_valid()) {
        return null;
    }
    let forecasts = weatherClient.info.get_forecast_list();
    let now = GLib.DateTime.new_now_local();
    for(let i = 0; i < forecasts.length; i++) {
        let [valid, timestamp] = forecasts[i].get_value_update();
        if(!valid || timestamp == 0) {
            continue;
        }
        let datetime = GLib.DateTime.new_from_unix_local(timestamp);
        if(now.difference(datetime) < 1800 * 1000 * 1000) {
            return forecasts[i];
        }
    }
}

function getWeatherImage(iconName) {
    let imageFile = Gio.File.new_for_path(path + iconName + '.svg');
    return Gio.FileIcon.new(imageFile);
}

function getIconSize(icon, context) {
    let width = icon.get_width();
    let height = icon.get_height();
    let size = icon.scaledIconSize;
    if(size == -1) {
        size = Math.min(width, height);
    }
    context.translate((width - size) / 2, (height - size) / 2);
    return size;
}

function redisplayIcons() {
    let controls = Main.overview._controls;
    if (!controls && Main.overview._overview) {
        controls = Main.overview._overview._controls; // Fallback for legacy GNOME versions
    }

    if (!controls) return;

    let appDisplay = controls._appDisplay;
    if (appDisplay) {
        let apps = appDisplay._orderedItems.slice();
        apps.forEach(icon => {
            if(icon._id == CALENDAR_FILE || icon._id == CLOCKS_FILE
            || icon._id == WEATHER_FILE) {
                icon.icon.update();
            }
        });
        let folderIcons = appDisplay._folderIcons;
        if (folderIcons) {
            folderIcons.forEach(folderIcon => {
                let appsInFolder = folderIcon.view._orderedItems.slice();
                appsInFolder.forEach(icon => {
                    if(icon._id == CALENDAR_FILE || icon._id == CLOCKS_FILE
                    || icon._id == WEATHER_FILE) {
                        icon.icon.update();
                    }
                });
                folderIcon.icon.update();
            });
        }
    }

    let dash = controls.dash;
    if (dash && dash._box) {
        let children = dash._box.get_children().filter(actor => {
            return actor.child
            && actor.child._delegate && actor.child._delegate.app;
        });
        children.forEach(actor => {
            let actorId = actor.child._delegate.app.get_id();
            if(actorId == CALENDAR_FILE || actorId == CLOCKS_FILE
            || actorId == WEATHER_FILE) {
                actor.child.icon.update();
            }
        });
    }

    let textureCache = St.TextureCache.get_default();
    textureCache.disconnect(textureHandler);
    textureCache.emit('icon-theme-changed');
    textureHandler = textureCache.connect('icon-theme-changed', () => {
        loadTheme();
        weatherClient.emit('changed');
    });
}

function destroyObjects() {
    let context = St.ThemeContext.get_for_stage(global.stage);
    context.get_theme().unload_stylesheet(stylesheetFile);
    calendarClocksIcons.forEach(calendarClocksIcon => {
        disposeIcon(calendarClocksIcon);
        calendarClocksIcon.destroy();
    });
    calendarClocksIcons = [];
    weatherIcons.forEach(weatherIcon => {
        disposeWeatherIcon(weatherIcon);
        weatherIcon.destroy();
    });
    weatherIcons = [];
    GLib.source_remove(weatherTimeout);
    St.TextureCache.get_default().disconnect(textureHandler);
    handlers.forEach(handler => {
        settings.disconnect(handler);
    });
    handlers = [];

    teardownFlatpakKeyfileWatch();
    if (gwSettingsMonitor && gwSettingsHandler) {
        gwSettingsMonitor.disconnect(gwSettingsHandler);
        gwSettingsMonitor = null;
        gwSettingsHandler = null;
    }

    weatherClient = weatherTimeout = null;
    calendar = calendar48 = symbolicCalendar = clocks = symbolicClocks = null;
    hour = symbolicHour = minute = symbolicMinute = second = null;
}

export default class DynamicIconsExtension extends Extension {
    enable() {
        Me = this;
        createWeatherClient();
        loadSettings();
        createTemperatureUnitMonitor();
        originalCreate = Shell.App.prototype.create_icon_texture;
        Shell.App.prototype.create_icon_texture = createIconTexture;
        redisplayIcons();
    }

    disable() {
        Shell.App.prototype.create_icon_texture = originalCreate;
        redisplayIcons();
        destroyObjects();
        settings = null;
        desktopInterfaceSettings = null;
        textureHandler = null;
        themeData = null;
        stylesheetFile = null;
        Me = null;
    }
}