// 把 supabase/schema.sql 应用到指定 Supabase 项目（Management API 的 database/query）
// 用法：node scripts/apply-schema.mjs <ref> <pat>
import { readFileSync } from 'node:fs'

const [, , ref, pat] = process.argv
if (!ref || !pat) {
  console.error('用法：node scripts/apply-schema.mjs <project-ref> <pat>')
  process.exit(1)
}

const sql = readFileSync('supabase/schema.sql', 'utf8')

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${pat}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
})

const text = await res.text()
console.log(`HTTP ${res.status}`)
console.log(text.slice(0, 4000))
process.exit(res.ok ? 0 : 1)
