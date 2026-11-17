Install uv, then Harbor (`uv tool install "harbor[runta]"`) and the Runta CLI (`brew install runta-dev/tap/runta` on macOS, `npm install -g @runta/runta-cli` on Linux). If `runta ps` fails, ask me to run `runta login`. Then run:

export RUNTA_CONFIG=~/.config/runta/config.toml
harbor run -d frontier-harness-eval/frontier-harness-eval@v1.1.0 -a oracle -e runta -l 1

Report whether the task passed and the job folder under ./jobs/.