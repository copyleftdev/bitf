"""Validation for bundled public replay candles."""
import math


def validate_candles(values,p):
    by_time={};ignored=duplicates=0
    for original in values:
        if not isinstance(original,list) or len(original)!=6:
            raise ValueError('invalid candle shape')
        row=[float(x) for x in original]
        if not all(math.isfinite(x) for x in row):raise ValueError('non-finite candle')
        t,low,high,opening,close,volume=row
        if t!=int(t) or int(t)%p['granularity_seconds'] or low<=0 or volume<0 or not low<=min(opening,close)<=max(opening,close)<=high:
            raise ValueError('invalid candle values')
        t=int(t);row[0]=t
        if not p['start']<=t<p['end_exclusive']:
            ignored+=1;continue
        if t in by_time:
            if by_time[t]!=row:raise ValueError('conflicting duplicate candle')
            duplicates+=1
        by_time[t]=row
    expected=list(range(p['start'],p['end_exclusive'],p['granularity_seconds']))
    candles=[by_time[t] for t in sorted(by_time)]
    return candles,{'present_candles':len(candles),'expected_candles':len(expected),
                    'coverage':len(candles)/len(expected),'missing_intervals':[t for t in expected if t not in by_time],
                    'outside_window_ignored':ignored,'identical_duplicates_removed':duplicates}
