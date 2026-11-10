// Окно «Вид терминала»: шрифт, межстрочный интервал, фон. Меняет вид сразу — открытый
// терминал слушает term-prefs и перестраивается под окном.
import { t } from './i18n';
import {
  FONT_MAX,
  FONT_MIN,
  LINE_HEIGHTS,
  TERM_FONTS,
  readTermPrefs,
  setTermPrefs,
  type TermBg,
  type TermFont,
} from './term-prefs';
import { THEME_CHOICES, setThemeChoice, themeChoice, type ThemeChoice } from './theme';
import { iconButton, openModal } from './ui';

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'th-field';
  const span = document.createElement('span');
  span.className = 'th-field__label';
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

function segment<T>(
  label: string,
  options: Array<{ value: T; label: string }>,
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const seg = document.createElement('div');
  seg.className = 'th-segment';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', label);
  const buttons: HTMLButtonElement[] = [];
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'th-segment__btn';
    btn.textContent = opt.label;
    btn.setAttribute('role', 'radio');
    const mark = (active: boolean): void => {
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    };
    mark(opt.value === current);
    btn.addEventListener('click', () => {
      for (const b of buttons) {
        b.classList.remove('is-active');
        b.setAttribute('aria-checked', 'false');
      }
      mark(true);
      onPick(opt.value);
    });
    buttons.push(btn);
    seg.append(btn);
  }
  return field(label, seg);
}

export function openTermSettings(): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-termview';

    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('termview.title');
    head.append(title, iconButton('close', t('common.close'), close));

    let prefs = readTermPrefs();

    // Размер шрифта: − значение +
    const stepper = document.createElement('div');
    stepper.className = 'th-termview__stepper';
    const value = document.createElement('span');
    value.className = 'th-termview__value';
    const minus = document.createElement('button');
    const plus = document.createElement('button');
    for (const [btn, text, label] of [
      [minus, '−', t('term.fontDecrease')],
      [plus, '+', t('term.fontIncrease')],
    ] as const) {
      btn.type = 'button';
      btn.className = 'th-btn th-termview__step';
      btn.textContent = text;
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    const syncFont = (): void => {
      value.textContent = `${prefs.fontSize} px`;
      minus.disabled = prefs.fontSize <= FONT_MIN;
      plus.disabled = prefs.fontSize >= FONT_MAX;
    };
    const step = (delta: number): void => {
      prefs = setTermPrefs({ fontSize: prefs.fontSize + delta });
      syncFont();
    };
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    stepper.append(minus, value, plus);
    syncFont();

    const lineLabels = [t('termview.lineTight'), t('termview.lineNormal'), t('termview.lineLoose')];
    const line = segment(
      t('termview.lineHeight'),
      LINE_HEIGHTS.map((v, i) => ({ value: v as number, label: lineLabels[i]! })),
      prefs.lineHeight,
      (lineHeight) => (prefs = setTermPrefs({ lineHeight })),
    );
    const bg = segment<TermBg>(
      t('termview.bg'),
      [
        { value: 'soft', label: t('termview.bgSoft') },
        { value: 'contrast', label: t('termview.bgContrast') },
      ],
      prefs.bg,
      (value) => (prefs = setTermPrefs({ bg: value })),
    );

    const fontSelect = document.createElement('select');
    fontSelect.className = 'th-sort__select th-termview__select';
    fontSelect.setAttribute('aria-label', t('termview.font'));
    for (const key of Object.keys(TERM_FONTS) as TermFont[]) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = TERM_FONTS[key].label || t('termview.fontSystem');
      opt.selected = key === prefs.font;
      fontSelect.append(opt);
    }
    fontSelect.addEventListener('change', () => {
      prefs = setTermPrefs({ font: fontSelect.value as TermFont });
    });

    // Тема — всего приложения сразу. Пустой setTermPrefs лишь будит открытый терминал,
    // чтобы он перечитал краски.
    const scheme = segment<ThemeChoice>(
      t('termview.scheme'),
      THEME_CHOICES.map((value) => ({ value, label: t(`termview.scheme_${value}`) })),
      themeChoice(),
      (value) => {
        setThemeChoice(value);
        prefs = setTermPrefs({});
      },
    );
    const holo = segment<boolean>(
      t('termview.holo'),
      [
        { value: false, label: t('termview.holoAlways') },
        { value: true, label: t('termview.holoHover') },
      ],
      prefs.holoAuto,
      (value) => (prefs = setTermPrefs({ holoAuto: value })),
    );

    const side = segment<boolean>(
      t('termview.tabs'),
      [
        { value: false, label: t('termview.tabsTop') },
        { value: true, label: t('termview.tabsSide') },
      ],
      prefs.sideTabs,
      (value) => (prefs = setTermPrefs({ sideTabs: value })),
    );

    box.append(
      head,
      field(t('termview.fontSize'), stepper),
      field(t('termview.font'), fontSelect),
      line,
      scheme,
      bg,
      holo,
      side,
    );
    return box;
  });
}
