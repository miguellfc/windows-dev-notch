import type { SystemAlertSettings } from "../../shared/settings/schema";
import type { SystemAlerts } from "../../shared/system/schema";

/** Fixed hysteresis: an alert clears only once the metric is this many points back on the safe side. */
const HYSTERESIS = 5;

export interface DiskFree {
  letter: string;
  freePercent: number;
}

export interface AlertInput {
  /** Sample instant in ms; the evaluator never reads the clock itself. */
  now: number;
  cpuPercent: number | null;
  ramPercent: number | null;
  battery: { percent: number; pluggedIn: boolean } | null;
  /** `null` = no new disk reading this tick: keep the last one. */
  disks: DiskFree[] | null;
}

export interface AlertEvaluator {
  evaluate(input: AlertInput, settings: SystemAlertSettings): SystemAlerts;
  /** Drops the CPU window, the last disk reading and every alert state (e.g. after a sampling pause). */
  reset(): void;
}

type AlertKey = keyof SystemAlertSettings;

interface CpuSample {
  at: number;
  value: number;
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const sameSettings = (a: object | undefined, b: object): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

const worstDisk = (disks: readonly DiskFree[]): DiskFree | null => {
  let worst: DiskFree | null = null;
  for (const disk of disks)
    if (worst === null || disk.freePercent < worst.freePercent) worst = disk;
  return worst;
};

/**
 * Pure threshold evaluator for the system alerts: sustained CPU, RAM, battery and the worst fixed drive,
 * each with a fixed 5-point hysteresis. Changing an alert's settings recomputes it without its previous
 * state, so raising a threshold above the current value clears it on the next evaluation.
 */
export function createAlertEvaluator(): AlertEvaluator {
  let cpuWindow: CpuSample[] = [];
  let lastDisks: DiskFree[] | null = null;
  let cpu = false;
  let ram = false;
  let battery = false;
  let disk: DiskFree | null = null;
  let previous: Partial<{ [K in AlertKey]: SystemAlertSettings[K] }> = {};

  /** Keeps the samples inside the window plus the newest older one, which proves the window is covered. */
  const recordCpu = (now: number, value: number | null, sustainMs: number) => {
    if (value !== null) cpuWindow.push({ at: now, value });
    const start = now - sustainMs;
    const firstInside = cpuWindow.findIndex((sample) => sample.at >= start);
    if (firstInside === -1) cpuWindow = cpuWindow.slice(-1);
    else if (firstInside > 1) cpuWindow = cpuWindow.slice(firstInside - 1);
  };

  const evaluateCpu = (
    now: number,
    value: number | null,
    s: SystemAlertSettings["cpu"],
    was: boolean,
  ) => {
    if (value === null) return was;
    if (value < s.percent - HYSTERESIS) return false;
    const start = now - s.sustainSeconds * 1000;
    const oldest = cpuWindow[0];
    const covered = oldest !== undefined && oldest.at <= start;
    const allHigh = cpuWindow.every(
      (sample) => sample.at < start || sample.value >= s.percent,
    );
    return (covered && allHigh) || was;
  };

  const evaluateRam = (
    value: number | null,
    s: SystemAlertSettings["ram"],
    was: boolean,
  ) => {
    if (value === null) return was;
    if (value >= s.percent) return true;
    if (value < s.percent - HYSTERESIS) return false;
    return was;
  };

  const evaluateBattery = (
    b: AlertInput["battery"],
    s: SystemAlertSettings["battery"],
    was: boolean,
  ) => {
    const percent = finite(b?.percent);
    if (b === null || percent === null || b.pluggedIn) return false;
    if (percent <= s.percent) return true;
    if (percent > s.percent + HYSTERESIS) return false;
    return was;
  };

  const evaluateDisk = (
    disks: readonly DiskFree[] | null,
    s: SystemAlertSettings["disk"],
    was: boolean,
  ) => {
    if (disks === null) return null;
    const worst = worstDisk(disks);
    if (worst === null || worst.freePercent >= s.freePercent + HYSTERESIS)
      return null;
    if (worst.freePercent < s.freePercent || was)
      return { letter: worst.letter, freePercent: worst.freePercent };
    return null;
  };

  return {
    evaluate(input, settings) {
      const fresh = (key: AlertKey) =>
        !sameSettings(previous[key], settings[key]);

      const cpuValue = finite(input.cpuPercent);
      recordCpu(input.now, cpuValue, settings.cpu.sustainSeconds * 1000);
      if (input.disks !== null) {
        lastDisks = input.disks
          .filter((d) => finite(d.freePercent) !== null)
          .map((d) => ({ letter: d.letter, freePercent: d.freePercent }));
      }

      cpu =
        settings.cpu.enabled &&
        evaluateCpu(input.now, cpuValue, settings.cpu, cpu && !fresh("cpu"));
      ram =
        settings.ram.enabled &&
        evaluateRam(
          finite(input.ramPercent),
          settings.ram,
          ram && !fresh("ram"),
        );
      battery =
        settings.battery.enabled &&
        evaluateBattery(
          input.battery,
          settings.battery,
          battery && !fresh("battery"),
        );
      disk = settings.disk.enabled
        ? evaluateDisk(
            lastDisks,
            settings.disk,
            disk !== null && !fresh("disk"),
          )
        : null;

      previous = {
        cpu: { ...settings.cpu },
        ram: { ...settings.ram },
        battery: { ...settings.battery },
        disk: { ...settings.disk },
      };
      return { cpu, ram, battery, disk: disk === null ? null : { ...disk } };
    },
    reset() {
      cpuWindow = [];
      lastDisks = null;
      cpu = false;
      ram = false;
      battery = false;
      disk = null;
      previous = {};
    },
  };
}
