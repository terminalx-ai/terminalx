#!/bin/zsh
# Idle survival test for issue #989: relay path, Settings tab, 10 min idle per keep-alive interval,
# then a 3 s trip to the background so the app's resume probe checks the old connection.
D=<device identifier>
APP=com.terminalx.next.mobile
OUT=${0:h}/idle
IDLE=${IDLE:-600}
mkdir -p $OUT
for K in ${=KS:-0 20000 30000 45000}; do
  RUN=idle-relay-$((K / 1000))s
  echo "$(date +%T) start $RUN"
  xcrun devicectl device process launch --device $D --terminate-existing --payload-url 'terminalx://settings' $APP -- -TXRunId $RUN -TXKeepAliveMs $K -TXNoDirect 1 >/dev/null 2>&1; rc=$?
  echo "$(date +%T) launch exit $rc"; [ $rc -eq 0 ] || exit $rc
  sleep $IDLE
  xcrun devicectl device process launch --device $D com.apple.Preferences >/dev/null 2>&1; rc=$?
  echo "$(date +%T) to background exit $rc"; [ $rc -eq 0 ] || exit $rc
  sleep 3
  xcrun devicectl device process launch --device $D $APP >/dev/null 2>&1; rc=$?
  echo "$(date +%T) to foreground exit $rc"; [ $rc -eq 0 ] || exit $rc
  sleep 15
  xcrun devicectl device copy from --device $D --domain-type appDataContainer --domain-identifier $APP --source Documents/measure/$RUN.jsonl --destination $OUT/$RUN.jsonl >/dev/null 2>&1; rc=$?
  echo "$(date +%T) pull exit $rc"; [ $rc -eq 0 ] || exit $rc
done
echo "$(date +%T) done"
