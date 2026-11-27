// アノテーションのページを、最後まで順に読む。現在位置が変わったら、古い読み込みは捨てる。
import type {
  AnnotationCursor,
  AnnotationPage,
  AnnotationRow,
} from "../project-data/types";

export async function loadAllPages(
  fetchPage: (cursor: AnnotationCursor | null) => Promise<AnnotationPage>,
  isCurrent: () => boolean,
): Promise<AnnotationRow[] | null> {
  const rows: AnnotationRow[] = [];
  let cursor: AnnotationCursor | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    if (!isCurrent()) return null;
    rows.push(...page.rows);
    if (page.next === null) return rows;
    cursor = page.next;
  }
}
