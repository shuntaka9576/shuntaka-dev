/* tslint:disable */
/* eslint-disable */

/**
 * 変換前に事前フェッチが必要な URL を列挙する
 */
export function collectResourceUrls(markdown: string): string[];

/**
 * 事前フェッチ済みリソース（Record<string, string>）を使って変換する。
 * フェッチに失敗した URL はマップに入れなければ元の URL のまま残る
 */
export function convertMarkdownWithResources(markdown: string, resources: any): string;
