declare module 'proper-lockfile' {
  interface LockOptions {
    stale?: number
    update?: number
    realpath?: boolean
    onCompromised?: (error: Error) => void
  }
  const lockfile: {
    lock(file: string, options?: LockOptions): Promise<() => Promise<void>>
  }
  export default lockfile
}
