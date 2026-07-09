project = "shuntaka"
copyright = "2024, classmethod"

extensions = [
    "sphinxcontrib.mermaid",
    "myst_parser",
    "sphinx_copybutton",
    "sphinx_last_updated_by_git",
]

exclude_patterns = []

language = "ja"

html_static_path = ["_static"]
html_theme = "sphinx_rtd_theme"
html_theme_options = {
    "collapse_navigation": True,
    "navigation_depth": 3,
}

# https://github.com/mgaitan/sphinxcontrib-mermaid?tab=readme-ov-file#markdown-support
myst_fence_as_directive = ["mermaid"]

# MyST の追加記法 (取り消し線 / ::: 記法のアドモニション / 定義リスト)
myst_enable_extensions = ["strikethrough", "colon_fence", "deflist"]

# H1〜H3 の見出しに自動 slug を付けて `foo.md#slug` のアンカー参照を有効にする
myst_heading_anchors = 3

# HTML のみビルドしているため MyST の strikethrough 警告 (HTML 以外向け) を抑止
suppress_warnings = ["myst.strikethrough"]

# sphinx-copybutton: シェル/PowerShellのプロンプト記号もコピー時に除外する
copybutton_prompt_text = r"^\s*(\$|>|#|sudo |PS\s.*?>\s)"
copybutton_prompt_is_regexp = True
copybutton_only_copy_prompt_lines = False
