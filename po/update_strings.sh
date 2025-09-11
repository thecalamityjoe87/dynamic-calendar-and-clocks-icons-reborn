#!/bin/sh
SCRIPTDIR=`dirname $0`
xgettext  --from-code=UTF-8 -k_ -kN_  -o dynamic-calendar-and-clocks-icons.pot "$SCRIPTDIR"/../dynamic-calendar-and-clocks-icons@thecalamityjoe87.github.com/*.js "$SCRIPTDIR"/../dynamic-calendar-and-clocks-icons@thecalamityjoe87.github.com//schemas/*.xml

for fn in *.po; do
	msgmerge -U "$fn" dynamic-calendar-and-clocks-icons.pot
done
