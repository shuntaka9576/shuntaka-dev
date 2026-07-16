"""PLaMO tokenizer に合わせた Markdown document chunking."""

from dataclasses import dataclass
import re
from typing import Protocol


CHUNKING_VERSION = "plamo-markdown-1024-v1"
METADATA_TOKEN_BUDGET = 256


class Tokenizer(Protocol):
    def encode(self, text: str, add_special_tokens: bool = False) -> list[int]: ...

    def decode(self, token_ids: list[int], skip_special_tokens: bool = True) -> str: ...


@dataclass(frozen=True)
class MarkdownSection:
    heading: str | None
    content: str


@dataclass(frozen=True)
class DocumentChunk:
    index: int
    heading: str | None
    content: str
    embedding_text: str
    token_count: int


_HEADING_PATTERN = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$")
_CLOSING_HASHES_PATTERN = re.compile(r"[ \t]+#+[ \t]*$")
_FENCE_PATTERN = re.compile(r"^[ \t]*(`{3,}|~{3,})")


def split_markdown_sections(content: str) -> list[MarkdownSection]:
    """見出し階層を保ちながら Markdown を section に分割する。"""

    sections: list[MarkdownSection] = []
    headings: list[str] = []
    lines: list[str] = []
    current_heading: str | None = None
    fence_marker: str | None = None

    def flush() -> None:
        nonlocal lines
        body = "\n".join(lines).strip()
        if body:
            sections.append(MarkdownSection(heading=current_heading, content=body))
        lines = []

    for line in content.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        fence = _FENCE_PATTERN.match(line)
        if fence:
            marker = fence.group(1)[0]
            if fence_marker is None:
                fence_marker = marker
            elif fence_marker == marker:
                fence_marker = None
            lines.append(line)
            continue

        heading = _HEADING_PATTERN.match(line) if fence_marker is None else None
        if heading:
            flush()
            level = len(heading.group(1))
            title = _CLOSING_HASHES_PATTERN.sub("", heading.group(2)).strip()
            headings = headings[: level - 1]
            while len(headings) < level - 1:
                headings.append("")
            headings.append(title)
            current_heading = " > ".join(value for value in headings if value)
            continue

        lines.append(line)

    flush()
    return sections


def _token_ids(tokenizer: Tokenizer, text: str) -> list[int]:
    return list(tokenizer.encode(text, add_special_tokens=False))


def _token_count(tokenizer: Tokenizer, text: str) -> int:
    return len(_token_ids(tokenizer, text))


def _metadata_prefix(
    tokenizer: Tokenizer,
    title: str,
    description: str,
    heading: str | None,
    max_tokens: int,
) -> str:
    fields = [f"タイトル: {title.strip()}"]
    if heading:
        fields.append(f"見出し: {heading.strip()}")
    if description.strip():
        fields.append(f"概要: {description.strip()}")

    header = "\n".join(fields)
    suffix = "\n本文:\n"
    # metadata が長くても本文用の token budget を確保する。タイトル、見出し、概要の
    # 順なので、切り詰めが必要な場合も検索に重要な情報を優先できる。
    budget = min(METADATA_TOKEN_BUDGET, max_tokens // 2)
    suffix_tokens = _token_ids(tokenizer, suffix)
    header_tokens = _token_ids(tokenizer, header)
    header_budget = max(1, budget - len(suffix_tokens))
    if len(header_tokens) > header_budget:
        header = tokenizer.decode(
            header_tokens[:header_budget], skip_special_tokens=True
        ).strip()
    return f"{header}{suffix}"


def chunk_document(
    tokenizer: Tokenizer,
    *,
    title: str,
    description: str,
    content: str,
    max_tokens: int = 1024,
    overlap_tokens: int = 128,
) -> list[DocumentChunk]:
    """Markdown section を PLaMO の token 数で window 分割する。"""

    if not 64 <= max_tokens <= 4096:
        raise ValueError("max_tokens must be between 64 and 4096")
    if not 0 <= overlap_tokens < max_tokens:
        raise ValueError("overlap_tokens must be between 0 and max_tokens - 1")

    sections = split_markdown_sections(content)
    if not sections:
        sections = [MarkdownSection(heading=None, content="")]

    chunks: list[DocumentChunk] = []
    for section in sections:
        prefix = _metadata_prefix(
            tokenizer, title, description, section.heading, max_tokens
        )
        prefix_count = _token_count(tokenizer, prefix)
        body_budget = max_tokens - prefix_count
        if body_budget <= 0:
            raise ValueError("metadata leaves no token budget for content")

        body_tokens = _token_ids(tokenizer, section.content)
        if not body_tokens:
            embedding_text = prefix.rstrip()
            chunks.append(
                DocumentChunk(
                    index=len(chunks),
                    heading=section.heading,
                    content="",
                    embedding_text=embedding_text,
                    token_count=_token_count(tokenizer, embedding_text),
                )
            )
            continue

        start = 0
        while start < len(body_tokens):
            end = min(start + body_budget, len(body_tokens))
            window = body_tokens[start:end]
            body = tokenizer.decode(window, skip_special_tokens=True).strip()
            embedding_text = f"{prefix}{body}"
            token_count = _token_count(tokenizer, embedding_text)

            # SentencePiece は prefix と本文を結合した境界で再tokenize結果がわずかに
            # 変わり得る。最終入力を数え直し、1024 tokenを確実に超えないよう縮める。
            while token_count > max_tokens and len(window) > 1:
                overflow = token_count - max_tokens
                window = window[: max(1, len(window) - overflow - 1)]
                end = start + len(window)
                body = tokenizer.decode(window, skip_special_tokens=True).strip()
                embedding_text = f"{prefix}{body}"
                token_count = _token_count(tokenizer, embedding_text)

            chunks.append(
                DocumentChunk(
                    index=len(chunks),
                    heading=section.heading,
                    content=body,
                    embedding_text=embedding_text,
                    token_count=token_count,
                )
            )
            if end >= len(body_tokens):
                break
            effective_overlap = min(overlap_tokens, len(window) - 1)
            start = end - effective_overlap

    return chunks
