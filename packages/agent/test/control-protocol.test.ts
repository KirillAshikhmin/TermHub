import { describe, it, expect } from 'vitest';
import {
  ControlParser,
  escapeInput,
  type ControlEvent,
  type ControlOutputEvent,
} from '../src/control-protocol.js';

const enc = new TextEncoder();

/** Скармливает парсеру кусок потока, записанный как строка (UTF-8 байты). */
function feed(parser: ControlParser, chunk: string): ControlEvent[] {
  return parser.parse(enc.encode(chunk));
}

/** Сужение union'а: только события вывода панели. */
function outputs(events: ControlEvent[]): ControlOutputEvent[] {
  return events.filter((e): e is ControlOutputEvent => e.type === 'output');
}

/** Байты события как массив чисел — так ожидание в тесте читается глазами. */
function bytes(event: ControlOutputEvent): number[] {
  return Array.from(event.data);
}

describe('ControlParser: %output', () => {
  it('разбирает %output %<pane> <данные> и отдаёт байты панели', () => {
    const events = feed(new ControlParser(), '%output %0 hello\n');
    expect(outputs(events)).toHaveLength(1);
    expect(outputs(events)[0].pane).toBe('%0');
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('hello');
  });

  it('разэкранирует восьмеричные последовательности: \\015 \\012 \\033 \\134', () => {
    const events = feed(new ControlParser(), '%output %1 a\\015\\012\\033\\134b\n');
    // CR, LF, ESC, обратный слэш — и обычные байты вокруг них.
    expect(bytes(outputs(events)[0])).toEqual([0x61, 0x0d, 0x0a, 0x1b, 0x5c, 0x62]);
    expect(outputs(events)[0].pane).toBe('%1');
  });

  it('многобайтовый UTF-8 приходит сырым: кириллица и эмодзи не экранируются', () => {
    const events = feed(new ControlParser(), '%output %0 привет 🚀\n');
    // Ожидание — байты UTF-8, посчитанные независимо от кода парсера.
    expect(bytes(outputs(events)[0])).toEqual(Array.from(enc.encode('привет 🚀')));
  });

  it('байты вне восьмеричных последовательностей проходят как есть, включая одиночный \\', () => {
    const events = feed(new ControlParser(), '%output %0 a\\b\\09c\\7777\n');
    // \b, \09 и \777 — не «три восьмеричные цифры со значением ≤ 255», значит это
    // обычные байты: слэш сохраняется, цифры за ним тоже.
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('a\\b\\09c\\7777');
  });

  it('пустой %output валиден: событие есть, байтов ноль', () => {
    const events = feed(new ControlParser(), '%output %2 \n');
    expect(outputs(events)).toHaveLength(1);
    expect(bytes(outputs(events)[0])).toEqual([]);
  });

  it('%output без идентификатора панели события не даёт, а поток живёт дальше', () => {
    // Событие вывода без панели отдавать нельзя: по этому полю отбирают свою панель.
    const parser = new ControlParser();
    expect(feed(parser, '%output\n%output \n')).toEqual([]);
    expect(outputs(feed(parser, '%output %0 живой\n'))).toHaveLength(1);
  });

  it('данные соседней панели не смешиваются: у каждого события свой идентификатор', () => {
    const events = feed(new ControlParser(), '%output %0 one\n%output %3 two\n');
    expect(outputs(events).map((e) => e.pane)).toEqual(['%0', '%3']);
    expect(outputs(events).map((e) => new TextDecoder().decode(e.data))).toEqual(['one', 'two']);
  });
});

describe('ControlParser: склейка кусков потока', () => {
  it('хвост без перевода строки не разбирается раньше времени', () => {
    const parser = new ControlParser();
    expect(feed(parser, '%output %0 hel')).toEqual([]);
  });

  it('строка, разорванная между вызовами parse, склеивается и отдаётся один раз', () => {
    const parser = new ControlParser();
    feed(parser, '%output %0 hel');
    const events = feed(parser, 'lo\n');
    expect(outputs(events)).toHaveLength(1);
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('hello');
  });

  it('разрыв внутри восьмеричной последовательности не теряет байт', () => {
    const parser = new ControlParser();
    feed(parser, '%output %0 a\\01');
    const events = feed(parser, '2b\n');
    expect(bytes(outputs(events)[0])).toEqual([0x61, 0x0a, 0x62]);
  });

  it('разрыв внутри многобайтового символа не портит его', () => {
    const parser = new ControlParser();
    const raw = enc.encode('%output %0 привет\n');
    // '%output %0 ' — 11 байт, дальше 'п' занимает байты 11 и 12: разрыв на 12 приходится
    // ВНУТРЬ символа, а не на его границу.
    const split = 12;
    expect(parser.parse(raw.subarray(0, split))).toEqual([]);
    const events = parser.parse(raw.subarray(split));
    const text = new TextDecoder().decode(outputs(events)[0].data);
    expect(text).toBe('привет');
    expect(text).not.toContain('�'); // ни одного символа замены
  });

  it('перевод строки CRLF от pty не оставляет CR в данных панели', () => {
    // node-pty отдаёт поток через терминальный драйвер, а тот превращает LF в CRLF.
    const events = feed(new ControlParser(), '%output %0 hi\r\n');
    expect(bytes(outputs(events)[0])).toEqual([0x68, 0x69]);
  });

  it('незавершённая строка сверх предела длины выбрасывается, следующая разбирается', () => {
    // Предел — 1 МиБ на строку; полтора мегабайта без перевода строки его перешагивают.
    // Проверяем на %output: без предела он дошёл бы до экрана вторым событием.
    const parser = new ControlParser();
    expect(feed(parser, `%output %0 ${'x'.repeat(1_500_000)}`)).toEqual([]);
    const events = feed(parser, 'хвост выброшенной строки\n%output %0 живой\n');
    expect(outputs(events)).toHaveLength(1);
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('живой');
  });
});

describe('ControlParser: уведомления', () => {
  it('смена окна и панели приходит уведомлениями со своими полями', () => {
    const events = feed(new ControlParser(), '%session-window-changed $0 @1\n%window-add @1\n');
    expect(events).toEqual([
      { type: 'notification', name: 'session-window-changed', args: ['$0', '@1'] },
      { type: 'notification', name: 'window-add', args: ['@1'] },
    ]);
  });

  it('уведомление без полей: %exit', () => {
    expect(feed(new ControlParser(), '%exit\n')).toEqual([{ type: 'notification', name: 'exit', args: [] }]);
  });

  it('неизвестное уведомление не роняет разбор и отдаётся как notification', () => {
    const parser = new ControlParser();
    const events = feed(parser, '%что-угодно 1 2\n%output %0 ok\n');
    expect(events[0]).toEqual({ type: 'notification', name: 'что-угодно', args: ['1', '2'] });
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('ok');
  });

  it('строка без ведущего % вне блока событием не становится', () => {
    // Вне блока у протокола есть ровно одна форма строки — `%имя поля`. Строку без `%`
    // привязать не к чему: ни панели, ни номера команды в ней нет.
    const parser = new ControlParser();
    expect(feed(parser, 'строка без процента\n\n')).toEqual([]);
    expect(outputs(feed(parser, '%output %0 живой\n'))).toHaveLength(1);
  });

  it('строки обрамления блока вне блока уведомлениями не притворяются', () => {
    // %end и %error без своего %begin — обломки рассинхрона, а не уведомления tmux.
    const parser = new ControlParser();
    expect(feed(parser, '%end 1 3 1\n%error 1 3 1\n')).toEqual([]);
    expect(outputs(feed(parser, '%output %0 живой\n'))).toHaveLength(1);
  });
});

describe('ControlParser: блоки ответа на команду', () => {
  it('%begin … %end собирается целиком и отдаётся одним событием с номером команды', () => {
    const events = feed(new ControlParser(), '%begin 1757700000 7 1\n%0 @0 0\n%end 1757700000 7 1\n');
    expect(events).toEqual([{ type: 'block', id: 7, lines: ['%0 @0 0'] }]);
  });

  it('строки ответа не разбираются как протокол: тело capture-pane может начинаться с %', () => {
    const body = '%output %9 подделка\n%exit\n';
    const events = feed(new ControlParser(), `%begin 1 4 1\n${body}%end 1 4 1\n`);
    expect(events).toEqual([{ type: 'block', id: 4, lines: ['%output %9 подделка', '%exit'] }]);
  });

  it('%end и %error с чужим номером команды блок не закрывают', () => {
    const events = feed(new ControlParser(), '%begin 1 20 1\n%end 1 21 1\n%error 1 22 1\nтело\n%end 1 20 1\n');
    expect(events).toEqual([{ type: 'block', id: 20, lines: ['%end 1 21 1', '%error 1 22 1', 'тело'] }]);
  });

  it('%begin с неразбираемым номером команды блок не открывает и событием не становится', () => {
    // Испорченный заголовок не должен ни глотать поток, ни притворяться уведомлением.
    const parser = new ControlParser();
    expect(feed(parser, '%begin 1757700000 битый 1\n')).toEqual([]);
    expect(outputs(feed(parser, '%output %0 живой\n'))).toHaveLength(1);
  });

  it('блок без закрытия отбрасывается по пределу ошибкой, и разбор потока продолжается', () => {
    // Предел — 100 000 строк тела; полтораста тысяч его перешагивают. Отказ обязан выйти
    // событием ошибки: без него ждущая команда не разрешится, а ответом ей станет чужой блок.
    const parser = new ControlParser();
    expect(feed(parser, '%begin 1 31 1\n')).toEqual([]);
    const dropped = feed(parser, 'x\n'.repeat(150_000));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ type: 'error', id: 31 });
    const events = feed(parser, '%output %0 живой\n');
    expect(outputs(events)).toHaveLength(1);
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('живой');
  });

  it('строка тела длиннее предела портит блок целиком: ответ приходит ошибкой, а не неполным', () => {
    const parser = new ControlParser();
    feed(parser, '%begin 1 33 1\nпервая\n');
    const aborted = feed(parser, 'x'.repeat(1_500_000));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ type: 'error', id: 33 });
    // Хвост выброшенной строки и запоздавший %end наружу уже не выходят.
    const events = feed(parser, '\n%end 1 33 1\n%output %0 живой\n');
    expect(events).toHaveLength(1);
    expect(outputs(events)).toHaveLength(1);
  });

  it('законный длинный ответ под пределом отдаётся целиком', () => {
    // Снимок истории панели — это тысячи строк; предел не должен рубить их.
    const parser = new ControlParser();
    feed(parser, '%begin 1 32 1\n');
    feed(parser, 'строка\n'.repeat(20_000));
    const events = feed(parser, '%end 1 32 1\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'block', id: 32 });
    expect((events[0] as { lines: string[] }).lines).toHaveLength(20_000);
  });

  it('ответ без строк — блок с пустым списком', () => {
    const events = feed(new ControlParser(), '%begin 1 5 1\n%end 1 5 1\n');
    expect(events).toEqual([{ type: 'block', id: 5, lines: [] }]);
  });

  it('%begin без закрытия к концу потока не отдаётся вовсе', () => {
    const parser = new ControlParser();
    expect(feed(parser, '%begin 1 6 1\nхвост ответа\n')).toEqual([]);
  });

  it('блок, разорванный между кусками потока, собирается целиком', () => {
    const parser = new ControlParser();
    expect(feed(parser, '%begin 1 8 1\nпер')).toEqual([]);
    expect(feed(parser, 'вая\nвторая\n%end 1 8 1\n')).toEqual([
      { type: 'block', id: 8, lines: ['первая', 'вторая'] },
    ]);
  });

  it('блок, закрытый %error вместо %end, отдаётся событием ошибки с тем же номером', () => {
    const events = feed(new ControlParser(), "%begin 1 11 1\nunknown command: foo\n%error 1 11 1\n");
    expect(events).toEqual([{ type: 'error', id: 11, lines: ['unknown command: foo'] }]);
  });

  it('после %error разбор продолжается: следующий вывод панели доходит', () => {
    const events = feed(new ControlParser(), '%begin 1 12 1\nbad\n%error 1 12 1\n%output %0 живой\n');
    expect(events).toHaveLength(2);
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('живой');
  });

  it('вывод панели после блока продолжает разбираться', () => {
    const events = feed(new ControlParser(), '%begin 1 9 1\nтело\n%end 1 9 1\n%output %0 после\n');
    expect(events).toHaveLength(2);
    expect(new TextDecoder().decode(outputs(events)[0].data)).toBe('после');
  });
});

describe('escapeInput', () => {
  it('обычный набор с пробелом и переводом строки → по два hex-разряда на байт', () => {
    // l s <пробел> - l CR — коды посчитаны по таблице ASCII, не кодом модуля.
    expect(escapeInput(enc.encode('ls -l\r'))).toBe('6c 73 20 2d 6c 0d');
  });

  it('управляющие байты не теряют ведущий ноль', () => {
    expect(escapeInput(new Uint8Array([0x03, 0x1b, 0x00, 0x7f]))).toBe('03 1b 00 7f');
  });

  it('кавычки и обратный слэш уходят кодами, а не символами: разбирать нечего', () => {
    expect(escapeInput(enc.encode('"\'\\'))).toBe('22 27 5c');
  });

  it('многобайтовый символ кодируется по байту на аргумент', () => {
    expect(escapeInput(enc.encode('ё🚀'))).toBe('d1 91 f0 9f 9a 80');
  });

  it('пустой ввод — пустая строка: отправлять нечего', () => {
    expect(escapeInput(new Uint8Array(0))).toBe('');
  });

  it('send-keys -H восстановит исходные байты: обратный разбор совпадает с вводом', () => {
    const source = enc.encode('эхо "привет" && ls\r');
    const restored = escapeInput(source)
      .split(' ')
      .map((hex) => Number.parseInt(hex, 16));
    expect(restored).toEqual(Array.from(source));
  });
});

describe('ControlParser: обёртка iTerm2 в потоке -CC', () => {
  it('снимает обёртку начала потока и опознаёт склеенный с ней первый %begin', () => {
    // Байты сняты с живого tmux 3.7b: поток -CC начинается обёрткой iTerm2, приклеенной
    // к приветственному %begin. Без её снятия номер первого блока неизвестен, отправить
    // команду не с чем — и подключение скатывается на прежний tmux attach.
    const parser = new ControlParser();
    const greeting = '\x1bP1000p%begin 1789244339 306 0\n%end 1789244339 306 0\n';
    expect(feed(parser, greeting)).toEqual([{ type: 'block', id: 306, lines: [] }]);
    expect(outputs(feed(parser, '%output %0 живой\n'))).toHaveLength(1);
  });

  it('завершитель обёртки наружу не выходит — ни отдельной строкой, ни приклеенным', () => {
    // Так поток и кончается: %exit, затем завершитель без перевода строки.
    const parser = new ControlParser();
    expect(feed(parser, '%exit\r\n\x1b\\')).toEqual([{ type: 'notification', name: 'exit', args: [] }]);
    const glued = new ControlParser();
    expect(feed(glued, '%exit\x1b\\\n')).toEqual([{ type: 'notification', name: 'exit', args: [] }]);
  });

  it('внутри блока обёртку не снимаем: тело ответа — это содержимое, а не обрамление', () => {
    // capture-pane -e отдаёт строки с управляющими последовательностями; трогать их нельзя.
    const body = '\x1bP1000pтекст\x1b\\';
    const events = feed(new ControlParser(), `%begin 1 40 1\n${body}\n%end 1 40 1\n`);
    expect(events).toEqual([{ type: 'block', id: 40, lines: [body] }]);
  });
});
