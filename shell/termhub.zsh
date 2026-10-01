# TermHub shell commands. Source this file from zsh or bash.
tm() {
  if [ -n "$1" ]; then
    _th_taken=$(tmux -L termhub list-sessions -F '#{session_name}' 2>/dev/null) || _th_taken=''
    if printf '%s\n' "$_th_taken" | grep -qxF -- "$1"; then
      tmux -L termhub attach -t "=$1:"
    else
      tmux -L termhub new -s "$1"
    fi
    return $?
  fi
  _th_base=$(basename "$PWD")
  _th_taken=$(tmux -L termhub list-sessions -F '#{session_name}' 2>/dev/null) || _th_taken=''
  _th_name=$_th_base
  _th_n=0
  while printf '%s\n' "$_th_taken" | grep -qxF -- "$_th_name"; do
    _th_n=$((_th_n + 1))
    _th_name="$_th_base$_th_n"
  done
  tmux -L termhub new -s "$_th_name"
}
_th_rows() {
  _th_tab=$(printf '\t')
  _th_w=$(tmux -L termhub list-windows -a -F "#{session_name}${_th_tab}#{window_bell_flag}" 2>/dev/null)
  _th_s=$(tmux -L termhub list-sessions -F "#{session_path}${_th_tab}#{session_name}${_th_tab}#{pane_title}" 2>/dev/null)
  [ -z "$_th_s" ] && return 1
  { printf '%s\n' "$_th_w" | sed 's/^/B/'; printf '%s\n' "$_th_s" | sed 's/^/S/'; } |
  awk -v tab="$_th_tab" -v cur="$PWD" '
    BEGIN { FS = tab }
    /^B/ { n = substr($1, 2); if ($2 == "1") bell[n] = 1; next }
    /^S/ {
      p = substr($1, 2); name = $2; title = $3;
      label = sprintf("%-16s", name);
      rest = title; sub(/^[^ ]+ /, "", rest);
      if (rest == name && title != name) label = label "  " substr(title, 1, index(title, " ") - 1);
      else if (title != "" && title != name) label = label "  " title;
      if (bell[name]) label = label "  \360\237\224\224";
      printf "%d%s%s%s%s%s%s\n", (p == cur ? 0 : 1), tab, p, tab, name, tab, label;
    }' |
  sort -t"$_th_tab" -k1,1n -k2,2 -k3,3 | cut -f2-
}
_th_show() {
  _th_i=0
  _th_prev=
  while IFS="$_th_tab" read -r _th_dir _th_name _th_label; do
    [ -z "$_th_name" ] && continue
    if [ "$_th_dir" != "$_th_prev" ]; then
      if [ "$_th_dir" = "$PWD" ]; then printf '\n%s (current)\n' "$_th_dir"
      else printf '\n%s\n' "$_th_dir"; fi
      _th_prev=$_th_dir
    fi
    _th_i=$((_th_i + 1))
    printf '  %2d) %s\n' "$_th_i" "$_th_label"
  done <<_THEOF
$1
_THEOF
}
_th_field() { printf '%s\n' "$1" | cut -f"$2"; }
_th_kill() {
  if tmux -L termhub kill-session -t "=$1" 2>/dev/null; then printf 'Closed %s\n' "$1"
  else printf 'Could not close %s\n' "$1"; fi
}
tml() {
  _th_tab=$(printf '\t')
  _th_all=$(_th_rows) || { printf 'No termhub sessions.\n'; return 0; }
  _th_show "$_th_all"
  printf '\nSession number (-N closes, Enter cancels): '
  read -r _th_pick
  [ -z "$_th_pick" ] && return 0
  _th_neg=0
  case "$_th_pick" in -*) _th_neg=1; _th_pick=${_th_pick#-};; esac
  case "$_th_pick" in '' | *[!0-9]*) printf 'Enter a number.\n'; return 1;; esac
  _th_sel=$(printf '%s\n' "$_th_all" | sed -n "${_th_pick}p")
  if [ -z "$_th_sel" ]; then printf 'No session with that number.\n'; return 1; fi
  _th_dir=$(_th_field "$_th_sel" 1)
  _th_name=$(_th_field "$_th_sel" 2)
  if [ "$_th_neg" = 1 ]; then
    printf 'Close session %s? [y/N] ' "$_th_name"
    read -r _th_yes
    case "$_th_yes" in [yY] | [yY][eE][sS]) _th_kill "$_th_name";; *) printf 'Cancelled.\n';; esac
    return 0
  fi
  if [ "$_th_dir" != "$PWD" ]; then
    cd "$_th_dir" || { printf 'Cannot enter %s\n' "$_th_dir"; return 1; }
  fi
  tm "$_th_name"
}
tmc() {
  _th_tab=$(printf '\t')
  while :; do
    _th_all=$(_th_rows) || { printf 'No termhub sessions.\n'; return 0; }
    printf '\n\342\224\214\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\220\n'
    printf '\342\224\202  Close sessions \342\200\224 enter a number to close    \342\224\202\n'
    printf '\342\224\202  Use tml to attach to a session              \342\224\202\n'
    printf '\342\224\224\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\230\n'
    _th_show "$_th_all"
    printf '\nNumber to close (Enter exits): '
    read -r _th_pick || return 0
    [ -z "$_th_pick" ] && return 0
    case "$_th_pick" in *[!0-9]*) printf 'Enter a number.\n'; continue;; esac
    _th_sel=$(printf '%s\n' "$_th_all" | sed -n "${_th_pick}p")
    if [ -z "$_th_sel" ]; then printf 'No session with that number.\n'; continue; fi
    _th_kill "$(_th_field "$_th_sel" 2)"
  done
}
