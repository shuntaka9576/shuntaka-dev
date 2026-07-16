import unittest

from chunking import chunk_document, split_markdown_sections


class CharacterTokenizer:
    """1文字を1 tokenとして扱うテスト用tokenizer。"""

    def encode(self, text: str, add_special_tokens: bool = False) -> list[int]:
        del add_special_tokens
        return [ord(char) for char in text]

    def decode(self, token_ids: list[int], skip_special_tokens: bool = True) -> str:
        del skip_special_tokens
        return "".join(chr(token_id) for token_id in token_ids)


class ChunkingTest(unittest.TestCase):
    def test_split_markdown_sections_keeps_heading_hierarchy(self) -> None:
        sections = split_markdown_sections(
            "前書き\n\n# 親\n本文1\n## 子\n本文2\n# 次\n本文3"
        )

        self.assertEqual(
            [(section.heading, section.content) for section in sections],
            [
                (None, "前書き"),
                ("親", "本文1"),
                ("親 > 子", "本文2"),
                ("次", "本文3"),
            ],
        )

    def test_heading_inside_code_fence_is_not_a_section(self) -> None:
        sections = split_markdown_sections("# 見出し\n```md\n# コード\n```\n本文")

        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0].heading, "見出し")
        self.assertIn("# コード", sections[0].content)

    def test_hash_in_heading_text_is_preserved(self) -> None:
        sections = split_markdown_sections("# C#\n本文\n## 子見出し ###\n続き")

        self.assertEqual(sections[0].heading, "C#")
        self.assertEqual(sections[1].heading, "C# > 子見出し")

    def test_chunks_respect_token_limit_and_overlap(self) -> None:
        chunks = chunk_document(
            CharacterTokenizer(),
            title="記事",
            description="概要",
            content="# 節\n" + "あ" * 180,
            max_tokens=64,
            overlap_tokens=8,
        )

        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(chunk.token_count <= 64 for chunk in chunks))
        self.assertTrue(all(chunk.heading == "節" for chunk in chunks))
        self.assertEqual(chunks[0].content[-8:], chunks[1].content[:8])

    def test_empty_content_still_produces_metadata_chunk(self) -> None:
        chunks = chunk_document(
            CharacterTokenizer(),
            title="記事",
            description="概要",
            content="",
            max_tokens=64,
            overlap_tokens=8,
        )

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].content, "")
        self.assertIn("タイトル: 記事", chunks[0].embedding_text)


if __name__ == "__main__":
    unittest.main()
