export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('harbor:unauthorized'))
    }
    throw new ApiError(res.status, data?.error ?? res.statusText)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

export interface User {
  id: number
  username: string
}

export interface AuthStatus {
  setup_required: boolean
  user: User | null
}

export interface Update {
  id: number
  operation: string
  target_type: string
  target_name: string
  status: 'running' | 'success' | 'failed'
  log: string
  username: string
  started_at: string
  finished_at: string | null
  /** e.g. the commit a deploy built: "<sha7> <message>" */
  detail: string
  /** Image the operation ran (built tag or image ID), if any. */
  artifact: string
  /** Whether the settings it ran with were recorded (needed for rollback). */
  has_snapshot: boolean
}

export interface HostStats {
  hostname: string
  os: string
  kernel: string
  cpu_count: number
  cpu_percent: number
  mem_total: number
  mem_used: number
  disk_total: number
  disk_used: number
  load_average: [number, number, number]
  uptime: number
}

export interface SystemOverview {
  host: HostStats
  docker: {
    version: string
    api_version: string
    containers: number
    containers_running: number
    containers_stopped: number
    images: number
  } | null
  docker_error: string | null
}

// Docker engine shapes (subset of fields the UI uses).
export interface Port {
  IP?: string
  PrivatePort: number
  PublicPort?: number
  Type: string
}

export interface PortStatus {
  port: number
  protocol: string
  available: boolean
  /** Container name, "Harbor", or "another process". */
  used_by: string | null
}

export interface PortsResponse {
  checked: PortStatus[]
  suggestions: number[]
}

export interface ContainerSummary {
  Id: string
  Names: string[]
  Image: string
  ImageID: string
  Command: string
  Created: number
  State: string
  Status: string
  /** Omitted by newer Docker versions when nothing is published. */
  Ports?: Port[] | null
  Labels: Record<string, string>
}

export interface ContainerInspect {
  Id: string
  Name: string
  Created: string
  Image: string
  State: { Status: string; Running: boolean; StartedAt: string; ExitCode: number; Health?: { Status: string } }
  Config: { Image: string; Env: string[] | null; Cmd: string[] | null; Labels: Record<string, string> | null }
  HostConfig: { RestartPolicy?: { Name: string }; NetworkMode?: string }
  Mounts: { Type: string; Source: string; Destination: string; Mode: string; RW: boolean; Name?: string }[]
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> | null; Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null }
}

export interface ImageSummary {
  Id: string
  RepoTags: string[] | null
  RepoDigests: string[] | null
  Created: number
  Size: number
  InUse: boolean
}

export interface Volume {
  Name: string
  Driver: string
  Mountpoint: string
  CreatedAt?: string
  Labels: Record<string, string> | null
}

export interface Network {
  Id: string
  Name: string
  Driver: string
  Scope: string
  Created: string
  Internal: boolean
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] }
}

export type StackStatus = 'running' | 'stopped' | 'unhealthy' | 'down'

export type StackSource = 'inline' | 'git'

export interface Stack {
  id: number
  name: string
  /** Compose file content (inline stacks). */
  compose: string
  env: string
  created_at: string
  updated_at: string
  /** Directory compose resolves relative paths against; empty = Harbor's own. */
  project_dir: string
  source: StackSource
  git_url: string
  git_branch: string
  has_token: boolean
  /** Compose file path inside the repository. */
  compose_path: string
  auto_deploy: boolean
  webhook_secret: string
  last_commit: string
  last_commit_message: string
  pinned: boolean
  group_id: number | null
  /** null = automatic (account for the repo's host), 0 = none. */
  git_account_id: number | null
}

export interface StackListItem extends Stack {
  status: StackStatus
  containers_running: number
  containers_total: number
}

export interface StackDetail extends Stack {
  status: StackStatus
  containers: ContainerSummary[]
}

export type DeploymentSource = 'image' | 'git' | 'promote'

export interface Deployment {
  id: number
  name: string
  /** For git deployments, the most recently built image tag; for promote deployments, the artifact last promoted. */
  image: string
  ports: string
  env: string
  volumes: string
  network: string
  restart: string
  command: string
  created_at: string
  updated_at: string
  source: DeploymentSource
  git_url: string
  git_branch: string
  build_context: string
  dockerfile: string
  build_args: string
  /** The token itself is never returned. */
  has_token: boolean
  auto_deploy: boolean
  webhook_secret: string
  last_commit: string
  last_commit_message: string
  /** Container this deployment took over on import, until its first deploy. */
  adopted_container: string
  /** Extra container labels, KEY=value per line. */
  labels: string
  pinned: boolean
  group_id: number | null
  /** null = automatic (account for the repo's host), 0 = none. */
  git_account_id: number | null
  /** For promote deployments, the deployment whose deploys are promoted. */
  upstream_id: number | null
}

/** `owner/repo` for GitHub URLs, otherwise the URL itself. */
export function repoLabel(url: string): string {
  const s = url.replace(/\/$/, '').replace(/\.git$/, '')
  return s.replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '')
}

export interface DeploymentListItem extends Deployment {
  status: string
  container_id: string | null
  container_image: string | null
  /** Image the last successful deploy ran. */
  artifact: string | null
}

/** A successful deploy of a promote deployment's upstream. */
export interface Promotable extends Update {
  /** Whether its image still exists. */
  available: boolean
}

/** Short form of an artifact: a sha256 image ID shortened, a tag as is. */
export function shortArtifact(a: string): string {
  return a.startsWith('sha256:') ? a.slice(7, 19) : a
}

export interface DeploymentDetail extends Deployment {
  status: string
  container: ContainerInspect | null
}

// Importing containers Harbor didn't create (e.g. from Komodo).
export interface ImportContainerSummary {
  name: string
  service: string | null
  image: string
  state: string
  status: string
}

export interface ImportStackCandidate {
  project: string
  working_dir: string
  config_files: string[]
  containers: ImportContainerSummary[]
  compose_readable: boolean
  git_url: string | null
  git_branch: string | null
  git_had_credentials: boolean
  name_ok: boolean
  is_komodo: boolean
  is_harbor: boolean
}

export interface ImportContainerCandidate extends ImportContainerSummary {
  suggested_name: string
  ports: string[]
  is_komodo: boolean
  is_harbor: boolean
}

export interface ImportCandidates {
  stacks: ImportStackCandidate[]
  containers: ImportContainerCandidate[]
}

export interface ContainerImportPreview {
  container: string
  suggested_name: string
  image: string
  ports: string
  env: string
  volumes: string
  network: string
  restart: string
  command: string
  labels: string
  warnings: string[]
}

export interface CanvasGroup {
  id: number
  name: string
  position: number
  collapsed: boolean
}

export interface GitAccount {
  id: number
  name: string
  host: string
  username: string
  has_token: boolean
  created_at: string
}

/** Host of a git URL (https, ssh or scp-style), lowercased. */
export function gitHost(url: string): string | null {
  const u = url.trim()
  if (!u) return null
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return 'github.com' // owner/repo shorthand
  const rest = u.includes('://') ? u.split('://')[1] : u.includes('@') ? u.split('@')[1] : null
  if (!rest) return null
  const host = rest.split('@').pop()!.split(/[/:]/)[0].toLowerCase()
  return host || null
}

export interface VolumeDetail {
  name: string
  driver: string
  mountpoint: string
  created_at: string | null
  labels: Record<string, string>
  used_by: { id: string; name: string; state: string; destination: string }[]
}

export interface VolumeEntry {
  name: string
  kind: 'dir' | 'file' | 'link' | 'other'
  size: number
  /** Unix seconds. */
  modified: number
  mode: string
}

export interface VolumeListing {
  path: string
  entries: VolumeEntry[]
  truncated: boolean
}

export interface VolumeFilePreview {
  path: string
  content: string | null
  binary: boolean
  truncated: boolean
}
