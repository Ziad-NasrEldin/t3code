export interface OfficePreferences {
  mute: boolean;
  music: number;
  effects: number;
  reducedMotion: boolean;
  bubbles: boolean;
  quality: "low" | "standard";
}
const DEFAULT_OFFICE_PREFERENCES: OfficePreferences = {
  mute: true,
  music: 0,
  effects: 0.15,
  reducedMotion: false,
  bubbles: true,
  quality: "standard",
};
export function readOfficePreferences(): OfficePreferences {
  try {
    const data: unknown = JSON.parse(
      localStorage.getItem("t3:signal-office:preferences:v1") ?? "null",
    );
    if (typeof data !== "object" || data === null) return DEFAULT_OFFICE_PREFERENCES;
    const p = data as Partial<OfficePreferences>;
    return {
      mute: typeof p.mute === "boolean" ? p.mute : true,
      music: typeof p.music === "number" ? Math.max(0, Math.min(1, p.music)) : 0,
      effects: typeof p.effects === "number" ? Math.max(0, Math.min(1, p.effects)) : 0.15,
      reducedMotion: p.reducedMotion === true,
      bubbles: p.bubbles !== false,
      quality: p.quality === "low" ? "low" : "standard",
    };
  } catch {
    return DEFAULT_OFFICE_PREFERENCES;
  }
}
export class OfficeAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private prefs: OfficePreferences = DEFAULT_OFFICE_PREFERENCES;
  private lastCue = Number.NEGATIVE_INFINITY;
  private chord = 0;
  private ducked = false;
  unlock() {
    if (typeof AudioContext === "undefined") return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
    }
    void this.context.resume().catch(() => {});
    this.apply(this.prefs, this.ducked);
  }
  apply(prefs: OfficePreferences, ducked: boolean) {
    this.prefs = prefs;
    this.ducked = ducked;
    const context = this.context;
    if (!context || !this.master) return;
    if (!prefs.mute && context.state === "suspended") void context.resume().catch(() => {});
    this.master.gain.setTargetAtTime(prefs.mute ? 0 : 1, context.currentTime, 0.15);
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (!prefs.mute && prefs.music > 0) {
      const play = () => {
        const chords = [
          [130.81, 164.81, 196],
          [110, 146.83, 174.61],
          [98, 130.81, 164.81],
          [116.54, 146.83, 174.61],
        ];
        for (const hz of chords[this.chord++ % 4]!)
          this.note(hz, 4.8, prefs.music * (ducked ? 0.008 : 0.02), 0, "sine");
      };
      play();
      this.interval = setInterval(play, 6000);
    }
  }
  private note(hz: number, duration: number, volume: number, delay: number, type: OscillatorType) {
    const context = this.context,
      master = this.master;
    if (!context || !master || context.state !== "running") return;
    const oscillator = context.createOscillator(),
      gain = context.createGain(),
      at = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.value = hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.01);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
  cue(kind: "arrival" | "settle" | "room") {
    const context = this.context;
    if (
      !context ||
      this.prefs.mute ||
      this.prefs.effects === 0 ||
      context.currentTime - this.lastCue < 0.8
    )
      return;
    this.lastCue = context.currentTime;
    const notes = kind === "arrival" ? [392, 523.25] : kind === "settle" ? [392, 261.63] : [196];
    notes.forEach((hz, i) => this.note(hz, 0.35, this.prefs.effects * 0.08, i * 0.09, "sine"));
  }
  suspend() {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    void this.context?.suspend().catch(() => {});
  }
  dispose() {
    this.suspend();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.master = null;
  }
}
