project = "shuntaka"
copyright = "2024, classmethod"

extensions = ["sphinxcontrib.mermaid", "myst_parser"]

templates_path = ["_templates"]
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
