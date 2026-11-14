import type { LucideIcon } from 'lucide-react'
import type { Platform } from '../../../shared/code-review/schema'
import { GithubMark, GitlabMark } from '../../shared/brand-icons'

export const PLATFORM_ICONS: Readonly<Record<Platform, LucideIcon>> = { github: GithubMark, gitlab: GitlabMark }
