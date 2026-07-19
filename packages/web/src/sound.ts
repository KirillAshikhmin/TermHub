// Звук звонка терминала: короткий двухтоновый бип через WebAudio. Контекст
// разблокируется первым pointerdown (политика автозапуска аудио в браузерах).

let ctx: AudioContext | null = null;
let unlocked = false;

/** Возвращает AudioContext, создавая его лениво (с webkit-префиксом для Safari). */
function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Ставит одноразовый слушатель первого pointerdown, который разблокирует аудио. */
export function initAudioUnlock(): void {
  const unlock = (): void => {
    unlocked = true;
    const audio = audioContext();
    if (audio && audio.state === 'suspended') void audio.resume();
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
}

/** Один тон заданной частоты с мягкой атакой/затуханием. */
function tone(audio: AudioContext, freq: number, start: number, duration: number): void {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.14, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** Двухтоновый бип; молчит, пока пользователь не разблокировал звук. */
export function playBell(): void {
  if (!unlocked) return;
  const audio = audioContext();
  if (!audio) return;
  if (audio.state === 'suspended') void audio.resume();
  const now = audio.currentTime;
  tone(audio, 880, now, 0.12);
  tone(audio, 1320, now + 0.13, 0.14);
}
