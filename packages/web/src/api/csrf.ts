let csrfToken: string | undefined

export function setAuthCsrfToken(token: string | undefined): void {
  csrfToken = token
}

export function getAuthCsrfToken(): string | undefined {
  return csrfToken
}
