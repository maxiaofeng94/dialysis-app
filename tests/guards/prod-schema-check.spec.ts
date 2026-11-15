/**
 * `scripts/check-prod-schema.mjs` 的解析逻辑单测。
 *
 * 为什么必须有：这个脚本是「生产库结构与代码不同步」的唯一机械防线。
 * 它自己算错（漏解析某张表 / 把注释里的表当成真的）就等于没有防线，
 * 而它的失败是**静默的绿**——最危险的一种。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { parseSchema } from '../../scripts/check-prod-schema.mjs'

describe('生产库结构检查 · schema.sql 解析', () => {
  it('解析出 create table if not exists 声明的表', () => {
    const sql = `
create table if not exists public.users (
  id uuid primary key,
  name text
);
create table if not exists public.patients (
  id uuid primary key
);
`
    const { tables } = parseSchema(sql)
    expect(tables).toEqual(['users', 'patients'])
  })

  it('解析出 add column if not exists 声明的列', () => {
    const sql = `
alter table public.blood_pressures add column if not exists pulse int;
alter table public.sessions add column if not exists doctor_uf numeric;
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c: { table: string; column: string }) => `${c.table}.${c.column}`)
    expect(keys).toContain('blood_pressures.pulse')
    expect(keys).toContain('sessions.doctor_uf')
  })

  it('解析出建表语句内部的列（表存在但列不全也要能查出来）', () => {
    const sql = `
create table if not exists public.patient_change_logs (
  id uuid primary key,
  patient_id uuid not null,
  old_value numeric,
  new_value numeric
);
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c: { table: string; column: string }) => `${c.table}.${c.column}`)
    expect(keys).toContain('patient_change_logs.old_value')
    expect(keys).toContain('patient_change_logs.new_value')
    // 约束关键字不能被当成列名
    expect(keys.some((k: string) => k.endsWith('.primary'))).toBe(false)
    expect(keys.some((k: string) => k.endsWith('.constraint'))).toBe(false)
  })

  it('大小写不敏感（CREATE TABLE IF NOT EXISTS 也要认）', () => {
    const sql = `CREATE TABLE IF NOT EXISTS public.admins (id uuid primary key);`
    const { tables } = parseSchema(sql)
    expect(tables).toContain('admins')
  })

  it('真实 schema.sql 必须能解析出本轮依赖的两个结构', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const { tables, columns } = parseSchema(sql)
    const keys = columns.map((c: { table: string; column: string }) => `${c.table}.${c.column}`)
    // 这两条就是第十一轮生产事故的直接原因
    expect(tables).toContain('patient_change_logs')
    expect(keys).toContain('blood_pressures.pulse')
  })
})
