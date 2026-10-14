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

export interface ContainerSummary {
  Id: string
  Names: string[]
  Image: string
  ImageID: string
  Command: string
  Created: number
  State: string
  Status: string
  Ports: Port[]
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

export interface Stack {
  id: number
  name: string
  compose: string
  env: string
  created_at: string
  updated_at: string
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

export interface Deployment {
  id: number
  name: string
  image: string
  ports: string
  env: string
  volumes: string
  network: string
  restart: string
  command: string
  created_at: string
  updated_at: string
}

export interface DeploymentListItem extends Deployment {
  status: string
  container_id: string | null
  container_image: string | null
}

export interface DeploymentDetail extends Deployment {
  status: string
  container: ContainerInspect | null
}
