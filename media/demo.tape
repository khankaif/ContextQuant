# Terminal recording for the README.
#   bun bench/compare/capture.ts     (once, saves the GitHub searches)
#   vhs media/demo.tape              (writes media/demo.gif)
Output media/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1100
Set Height 720
Set Padding 18
Set Theme "GitHub Dark"
Set WindowBar Colorful
Set TypingSpeed 60ms
Set Framerate 20

Hide
Type "export PS1='\[\e[32m\]~/ContextQuant\[\e[0m\] $ ' && clear"
Enter
Show

Sleep 800ms
Type "# 30 open bugs from microsoft/vscode, via the GitHub MCP server"
Sleep 500ms
Enter
Sleep 400ms
Type@45ms "bun bench/compare/demo.ts raw"
Sleep 600ms
Enter
Sleep 3.5s

Type "clear"
Enter
Sleep 500ms
Type "# same search, through contextquant"
Sleep 400ms
Enter
Sleep 300ms
Type@45ms "bun bench/compare/demo.ts cq"
Sleep 600ms
Enter
Sleep 7s
