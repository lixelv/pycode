# Geist Motion

Turns on the caret physics used by the python-coder editor (VS Code and Monaco
share the same editor engine):

| Setting | Value | Effect |
|---------|-------|--------|
| `editor.cursorSmoothCaretAnimation` | `on` | The caret glides to new positions while typing and when clicking or moving with the arrow keys. |
| `editor.cursorBlinking` | `smooth` | The caret fades in and out instead of hard blinking. |
| `editor.smoothScrolling` | `true` | Animated scrolling in the editor, lists and terminal. |

The extension only provides *defaults*, so any value you set yourself in
`settings.json` still takes precedence.
