// Имена — метки, а не tmux targets: даже «=$1:» может выбрать ID чужой сессии.
export const SESSION_ID_FORMAT = '#{session_id}\t#{session_name}';

export function isExistingSessionName(name: string): boolean {
  return name.length > 0 && !/[\u0000-\u001f\u007f]/.test(name);
}

export function findSessionId(output: string, name: string): string {
  if (!isExistingSessionName(name)) throw new Error('Invalid session name');
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0 && line.slice(tab + 1) === name && /^\$\d+$/.test(line.slice(0, tab)))
      return line.slice(0, tab);
  }
  throw Object.assign(new Error(`Session not found: ${name}`), { code: 1, stderr: `can't find session: ${name}` });
}

/** tmux разворачивает #formats и поглощает завершающий ; как разделитель команд. */
export function literalTmuxName(name: string): string {
  return name.replaceAll('#', '##').replace(/;$/, '\\;');
}
