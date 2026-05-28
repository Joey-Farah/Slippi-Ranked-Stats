"""Lead-maintenance & comeback grade matrices — tuning aid (CURRENT vs PROPOSED).

Scenario = stock-margin (yourStocks - oppStocks) path in a 4-stock game:
  LEAD     — reach a PEAK lead, then fall to a TROUGH.
  COMEBACK — sink to a TROUGH deficit, then climb to a RECOVERY high.

CURRENT formulas grade only the SIZE of the swing (give-back / climb), ignoring where you
ended up:
  lead     = (1 - min((peak-trough)/3, 1)) * (win ? 1 : 0.75)
  comeback =      min((high-trough)/3, 1)  * (win ? 1 : 0.75)

PROPOSED formulas grade the END POSITION through a shared position->score curve `pos()`:
  lead     = pos(trough) * (win ? 1 : 0.75)     # how far ahead you stayed at your worst
  comeback = pos(high)   * (win ? 1 : 0.75)     # how far you climbed back at your best
So "still ahead" and "actually completed the comeback" finally matter. (Open question, by
design: the PROPOSED version ignores swing SIZE — every row is identical — so a 3-stock lead
blown to even grades like a 2-stock one, and a 3-stock comeback to even like a 1-stock one.)
"""
import sys
sys.stdout.reconfigure(encoding="utf-8")

CB_LOSS_MULT = 0.75
THRESH = [(75, "S"), (63, "A"), (52, "B"), (40, "C"), (28, "D"), (0, "F")]

def grade(score):
    for t, g in THRESH:
        if score >= t:
            return g
    return "F"

def cell(deg):
    sc = round(deg * 100)
    return f"{grade(sc)}{sc}".center(7)

# Shared end-position -> score curve (margin in stocks).
POS = {1: 0.70, 0: 0.45, -1: 0.30, -2: 0.13}
def pos(m):
    if m >= 2:
        return 1.0
    return POS.get(m, 0.0)   # m <= -3 -> 0

# Size nudge: ~1/3 of a grade-notch per extra stock of how EXTREME your position got,
# holding the end fixed. Mirrored — lead docks for a bigger PEAK blown, comeback rewards
# a deeper TROUGH overcome.
NUDGE = 0.04
clamp01 = lambda x: max(0.0, min(1.0, x))

MARGINS = [3, 2, 1, 0, -1, -2, -3]

def cur_lead(peak, trough, won):
    return (1 - min((peak - trough) / 3, 1)) * (1 if won else CB_LOSS_MULT)
def new_lead(peak, trough, won):
    return clamp01(pos(trough) - NUDGE * (peak - 1)) * (1 if won else CB_LOSS_MULT)
def cur_cb(trough, high, won):
    return min((high - trough) / 3, 1) * (1 if won else CB_LOSS_MULT)
def new_cb(trough, high, won):
    return clamp01(pos(high) + NUDGE * (-trough - 1)) * (1 if won else CB_LOSS_MULT)

def lead_grid(title, fn, won):
    print(f"\n=== LEAD · {title} · {'WON' if won else 'LOST'} ===  (row=peak lead, col=lowest you fell to)")
    print("  PEAK \\ TROUGH │ " + "".join(f"{t:+d}".center(7) for t in MARGINS))
    print("  " + "─" * (16 + 7 * len(MARGINS)))
    for peak in (1, 2, 3):
        row = f"   +{peak} lead     │ "
        for t in MARGINS:
            row += "·".center(7) if t > peak else cell(fn(peak, t, won))
        print(row)

def cb_grid(title, fn, won):
    print(f"\n=== COMEBACK · {title} · {'WON' if won else 'LOST'} ===  (row=deepest deficit, col=highest you climbed to)")
    print("  TROUGH \\ HIGH │ " + "".join(f"{t:+d}".center(7) for t in MARGINS))
    print("  " + "─" * (16 + 7 * len(MARGINS)))
    for trough in (-1, -2, -3):
        row = f"   {trough} def      │ "
        for h in MARGINS:
            row += "·".center(7) if h < trough else cell(fn(trough, h, won))
        print(row)

lead_grid("PROPOSED + SIZE NUDGE", new_lead, won=True)
cb_grid("PROPOSED + SIZE NUDGE", new_cb, won=True)
print("\n  loss case = same grids x0.75.  · = impossible.  margin >0 ahead, 0 even, <0 behind.")
