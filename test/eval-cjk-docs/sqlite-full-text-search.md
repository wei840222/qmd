# SQLite FTS5 全文檢索

SQLite FTS5 全文檢索使用 tokenizer 建立倒排索引。BM25 負責詞彙排序；中文資料若只按字元切分，常見字可能造成過多候選結果。
