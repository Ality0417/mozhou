// v0.25.0（审查 S1）：ChapterExecutionPage 拆分出的共享类型与工具。
// 此前这些类型内联在 1989 行的页面文件里，抽出的子组件无法独立引用。
import type { NovelMemory, NovelPending } from '../../types'

/** 中文字符计数（字数分离口径：与服务端 word_count 一致） */
export function countCjk(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length
}

export type PendingData = NovelPending

export interface ProofreadIssue {
  type: string
  location: string
  problem: string
  suggestion: string
}

export interface CtxSection {
  key: string
  label: string
  chars: number
  tokens: number
}

export interface ChapterVersion {
  id: number
  note: string
  createdAt: string
  wordCount: number
  preview: string
}

// v1.0 后续（A1 多候选分支生成）：一份候选构想（各为一条 chapter_version 快照）
export interface CandidateDraft {
  index: number
  note: string
  content: string
  wordCount: number
  versionId: number
}

export interface ResourceDetail {
  title: string
  body: string
}

export type MemoryData = NovelMemory

export type ResourceTabKey = 'chapters' | 'characters' | 'world' | 'rules'
