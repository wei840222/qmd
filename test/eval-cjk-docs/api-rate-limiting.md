# API 速率限制

API rate limit 應回傳 429 與 Retry-After。Client 使用有上限的 exponential backoff，不應把失敗批次拆成大量單筆請求。
