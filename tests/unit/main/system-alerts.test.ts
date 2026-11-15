import { describe, expect, it } from "vitest";
import {
  createAlertEvaluator,
  type AlertInput,
} from "../../../src/main/system/alerts";
import {
  cloneDefaultSystemAlerts,
  type SystemAlertSettings,
} from "../../../src/shared/settings/schema";
import { NO_ALERTS } from "../../../src/shared/system/schema";

const input = (patch: Partial<AlertInput> = {}): AlertInput => ({
  now: 0,
  cpuPercent: null,
  ramPercent: null,
  battery: null,
  disks: null,
  ...patch,
});

const settings = (
  mutate: (s: SystemAlertSettings) => void = () => {},
): SystemAlertSettings => {
  const s = cloneDefaultSystemAlerts();
  mutate(s);
  return s;
};

/** Feeds one CPU sample per second from `from` to `to` (inclusive) and returns the last result. */
const feedCpu = (
  evaluator: ReturnType<typeof createAlertEvaluator>,
  from: number,
  to: number,
  value: number | null,
  s: SystemAlertSettings = settings(),
) => {
  let last = NO_ALERTS;
  for (let t = from; t <= to; t++)
    last = evaluator.evaluate(input({ now: t * 1000, cpuPercent: value }), s);
  return last;
};

describe("alert evaluator — CPU", () => {
  it("stays off until the window covers sustainSeconds of high samples", () => {
    const e = createAlertEvaluator();
    expect(feedCpu(e, 0, 29, 95).cpu).toBe(false);
    expect(feedCpu(e, 30, 30, 95).cpu).toBe(true);
  });

  it("does not turn on when one sample inside the window is below the threshold", () => {
    const e = createAlertEvaluator();
    feedCpu(e, 0, 10, 95);
    feedCpu(e, 11, 11, 89);
    expect(feedCpu(e, 12, 40, 95).cpu).toBe(false);
    // once the low sample at 11 s leaves the window [now − 30 s, now] it can turn on
    expect(feedCpu(e, 41, 41, 95).cpu).toBe(false);
    expect(feedCpu(e, 42, 42, 95).cpu).toBe(true);
  });

  it("accepts exactly the threshold as high", () => {
    const e = createAlertEvaluator();
    expect(feedCpu(e, 0, 30, 90).cpu).toBe(true);
  });

  it("keeps the alert on between threshold − 5 and threshold, turns off below threshold − 5", () => {
    const e = createAlertEvaluator();
    feedCpu(e, 0, 30, 95);
    expect(feedCpu(e, 31, 31, 87).cpu).toBe(true);
    expect(feedCpu(e, 32, 32, 85).cpu).toBe(true);
    expect(feedCpu(e, 33, 33, 84.9).cpu).toBe(false);
    // and needs a full sustained window again to come back
    expect(feedCpu(e, 34, 63, 95).cpu).toBe(false);
    expect(feedCpu(e, 64, 64, 95).cpu).toBe(true);
  });

  it("ignores null samples: they neither count as high nor cut an active alert", () => {
    const e = createAlertEvaluator();
    expect(feedCpu(e, 0, 0, null).cpu).toBe(false);
    feedCpu(e, 1, 31, 95);
    expect(
      e.evaluate(input({ now: 31_000, cpuPercent: 95 }), settings()).cpu,
    ).toBe(true);
    expect(feedCpu(e, 32, 40, null).cpu).toBe(true);
    expect(feedCpu(e, 41, 41, 95).cpu).toBe(true);
  });

  it("a null first sample does not make the window covered", () => {
    const e = createAlertEvaluator();
    feedCpu(e, 0, 0, null);
    expect(feedCpu(e, 1, 30, 95).cpu).toBe(false);
    expect(feedCpu(e, 31, 31, 95).cpu).toBe(true);
  });

  it("treats non-finite CPU values as null", () => {
    const e = createAlertEvaluator();
    feedCpu(e, 0, 30, 95);
    expect(feedCpu(e, 31, 31, Number.NaN).cpu).toBe(true);
    expect(feedCpu(e, 32, 32, Number.POSITIVE_INFINITY).cpu).toBe(true);
  });

  it("honours a custom sustainSeconds and percent", () => {
    const e = createAlertEvaluator();
    const s = settings((x) => {
      x.cpu.percent = 60;
      x.cpu.sustainSeconds = 5;
    });
    expect(feedCpu(e, 0, 4, 70, s).cpu).toBe(false);
    expect(feedCpu(e, 5, 5, 70, s).cpu).toBe(true);
    expect(feedCpu(e, 6, 6, 54, s).cpu).toBe(false);
  });

  it("turns off at once when disabled, and does not come back on until re-enabled", () => {
    const e = createAlertEvaluator();
    feedCpu(e, 0, 30, 95);
    const off = settings((x) => {
      x.cpu.enabled = false;
    });
    expect(feedCpu(e, 31, 31, 95, off).cpu).toBe(false);
    expect(feedCpu(e, 32, 70, 95, off).cpu).toBe(false);
  });

  it("recomputes without hysteresis when its settings change", () => {
    const e = createAlertEvaluator();
    feedCpu(e, 0, 30, 95);
    expect(feedCpu(e, 31, 31, 92).cpu).toBe(true);
    const higher = settings((x) => {
      x.cpu.percent = 95;
    });
    // 92 is within the old hysteresis band of 95 − 5 but the settings changed: recomputed fresh
    expect(feedCpu(e, 32, 32, 92, higher).cpu).toBe(false);
  });

  it("recomputing after a settings change can still turn on from the stored window", () => {
    const e = createAlertEvaluator();
    expect(feedCpu(e, 0, 30, 80).cpu).toBe(false);
    const lower = settings((x) => {
      x.cpu.percent = 75;
    });
    expect(feedCpu(e, 31, 31, 80, lower).cpu).toBe(true);
  });
});

describe("alert evaluator — RAM", () => {
  const ram = (
    e: ReturnType<typeof createAlertEvaluator>,
    value: number | null,
    s = settings(),
  ) => e.evaluate(input({ ramPercent: value }), s).ram;

  it("applies the threshold with 5-point hysteresis", () => {
    const e = createAlertEvaluator();
    expect(ram(e, 89.9)).toBe(false);
    expect(ram(e, 90)).toBe(true);
    expect(ram(e, 86)).toBe(true);
    expect(ram(e, 85)).toBe(true);
    expect(ram(e, 84.9)).toBe(false);
    expect(ram(e, 88)).toBe(false);
  });

  it("keeps its state on null or non-finite values", () => {
    const e = createAlertEvaluator();
    ram(e, 95);
    expect(ram(e, null)).toBe(true);
    expect(ram(e, Number.NaN)).toBe(true);
  });

  it("turns off at once when disabled", () => {
    const e = createAlertEvaluator();
    ram(e, 95);
    expect(
      ram(
        e,
        95,
        settings((x) => {
          x.ram.enabled = false;
        }),
      ),
    ).toBe(false);
  });

  it("recomputes without hysteresis when its settings change", () => {
    const e = createAlertEvaluator();
    ram(e, 92);
    expect(ram(e, 88)).toBe(true);
    expect(
      ram(
        e,
        88,
        settings((x) => {
          x.ram.percent = 89;
        }),
      ),
    ).toBe(false);
  });
});

describe("alert evaluator — battery", () => {
  const bat = (
    e: ReturnType<typeof createAlertEvaluator>,
    battery: AlertInput["battery"],
    s = settings(),
  ) => e.evaluate(input({ battery }), s).battery;

  it("turns on at or below the threshold on battery, off above threshold + 5", () => {
    const e = createAlertEvaluator();
    expect(bat(e, { percent: 16, pluggedIn: false })).toBe(false);
    expect(bat(e, { percent: 15, pluggedIn: false })).toBe(true);
    expect(bat(e, { percent: 20, pluggedIn: false })).toBe(true);
    expect(bat(e, { percent: 20.1, pluggedIn: false })).toBe(false);
    expect(bat(e, { percent: 18, pluggedIn: false })).toBe(false);
  });

  it("is off when plugged in or without a battery", () => {
    const e = createAlertEvaluator();
    expect(bat(e, { percent: 5, pluggedIn: true })).toBe(false);
    bat(e, { percent: 5, pluggedIn: false });
    expect(bat(e, null)).toBe(false);
    bat(e, { percent: 5, pluggedIn: false });
    expect(bat(e, { percent: 5, pluggedIn: true })).toBe(false);
  });

  it("treats a non-finite percent as no battery", () => {
    const e = createAlertEvaluator();
    bat(e, { percent: 5, pluggedIn: false });
    expect(bat(e, { percent: Number.NaN, pluggedIn: false })).toBe(false);
  });

  it("turns off when disabled and recomputes when settings change", () => {
    const e = createAlertEvaluator();
    bat(e, { percent: 10, pluggedIn: false });
    expect(
      bat(
        e,
        { percent: 10, pluggedIn: false },
        settings((x) => {
          x.battery.enabled = false;
        }),
      ),
    ).toBe(false);
    const e2 = createAlertEvaluator();
    bat(e2, { percent: 15, pluggedIn: false });
    expect(bat(e2, { percent: 18, pluggedIn: false })).toBe(true);
    expect(
      bat(
        e2,
        { percent: 18, pluggedIn: false },
        settings((x) => {
          x.battery.percent = 16;
        }),
      ),
    ).toBe(false);
  });
});

describe("alert evaluator — disk", () => {
  const disk = (
    e: ReturnType<typeof createAlertEvaluator>,
    disks: AlertInput["disks"],
    s = settings(),
  ) => e.evaluate(input({ disks }), s).disk;

  it("reports the worst drive below the threshold", () => {
    const e = createAlertEvaluator();
    expect(
      disk(e, [
        { letter: "C", freePercent: 30 },
        { letter: "D", freePercent: 12 },
      ]),
    ).toBeNull();
    expect(
      disk(e, [
        { letter: "C", freePercent: 8 },
        { letter: "D", freePercent: 5 },
      ]),
    ).toEqual({ letter: "D", freePercent: 5 });
  });

  it("stays on (reporting the current worst) until every drive has threshold + 5 free", () => {
    const e = createAlertEvaluator();
    disk(e, [
      { letter: "C", freePercent: 9 },
      { letter: "D", freePercent: 40 },
    ]);
    expect(
      disk(e, [
        { letter: "C", freePercent: 14 },
        { letter: "D", freePercent: 40 },
      ]),
    ).toEqual({ letter: "C", freePercent: 14 });
    expect(
      disk(e, [
        { letter: "C", freePercent: 15 },
        { letter: "D", freePercent: 40 },
      ]),
    ).toBeNull();
    expect(disk(e, [{ letter: "C", freePercent: 12 }])).toBeNull();
  });

  it("keeps the last result when no new disk data arrives", () => {
    const e = createAlertEvaluator();
    disk(e, [{ letter: "C", freePercent: 5 }]);
    expect(disk(e, null)).toEqual({ letter: "C", freePercent: 5 });
    disk(e, [{ letter: "C", freePercent: 50 }]);
    expect(disk(e, null)).toBeNull();
  });

  it("moves to the next worst drive or turns off when the worst disappears", () => {
    const e = createAlertEvaluator();
    disk(e, [
      { letter: "C", freePercent: 7 },
      { letter: "E", freePercent: 2 },
    ]);
    expect(disk(e, [{ letter: "C", freePercent: 7 }])).toEqual({
      letter: "C",
      freePercent: 7,
    });
    expect(disk(e, [{ letter: "D", freePercent: 40 }])).toBeNull();
    disk(e, [{ letter: "E", freePercent: 2 }]);
    expect(disk(e, [])).toBeNull();
  });

  it("ignores drives with a non-finite free percent", () => {
    const e = createAlertEvaluator();
    expect(
      disk(e, [
        { letter: "C", freePercent: Number.NaN },
        { letter: "D", freePercent: 40 },
      ]),
    ).toBeNull();
  });

  it("turns off when disabled and recomputes when settings change, even without new data", () => {
    const e = createAlertEvaluator();
    disk(e, [{ letter: "C", freePercent: 12 }]);
    expect(disk(e, null)).toBeNull();
    const higher = settings((x) => {
      x.disk.freePercent = 15;
    });
    expect(disk(e, null, higher)).toEqual({ letter: "C", freePercent: 12 });
    const lower = settings((x) => {
      x.disk.freePercent = 11;
    });
    // 12 would be within 15's hysteresis band, but the settings changed: recomputed fresh
    expect(disk(e, null, lower)).toBeNull();
    disk(e, [{ letter: "C", freePercent: 3 }], lower);
    expect(
      disk(
        e,
        [{ letter: "C", freePercent: 3 }],
        settings((x) => {
          x.disk.enabled = false;
        }),
      ),
    ).toBeNull();
  });
});

describe("alert evaluator — general", () => {
  it("returns NO_ALERTS for an empty input", () => {
    expect(createAlertEvaluator().evaluate(input(), settings())).toEqual(
      NO_ALERTS,
    );
  });

  it("a settings change on one alert does not reset the others", () => {
    const e = createAlertEvaluator();
    e.evaluate(
      input({ ramPercent: 95, battery: { percent: 10, pluggedIn: false } }),
      settings(),
    );
    const result = e.evaluate(
      input({ ramPercent: 87, battery: { percent: 18, pluggedIn: false } }),
      settings((x) => {
        x.battery.percent = 16;
      }),
    );
    expect(result.ram).toBe(true);
    expect(result.battery).toBe(false);
  });

  it("reset() clears the CPU window and every state", () => {
    const e = createAlertEvaluator();
    feedCpu(e, 0, 30, 95);
    e.evaluate(
      input({
        now: 31_000,
        cpuPercent: 95,
        ramPercent: 95,
        disks: [{ letter: "C", freePercent: 5 }],
      }),
      settings(),
    );
    e.reset();
    const after = e.evaluate(
      input({ now: 32_000, cpuPercent: 95, ramPercent: 87 }),
      settings(),
    );
    expect(after).toEqual(NO_ALERTS);
    expect(feedCpu(e, 33, 61, 95).cpu).toBe(false);
    expect(feedCpu(e, 62, 62, 95).cpu).toBe(true);
  });

  it("does not mutate the result it returned before", () => {
    const e = createAlertEvaluator();
    const first = e.evaluate(
      input({ disks: [{ letter: "C", freePercent: 5 }] }),
      settings(),
    );
    e.evaluate(
      input({ disks: [{ letter: "C", freePercent: 50 }] }),
      settings(),
    );
    expect(first.disk).toEqual({ letter: "C", freePercent: 5 });
  });
});
