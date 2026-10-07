/**
 * Whether a caller naming `requested` may act on a record owned by `owner`.
 *
 * Omitting either side is a trusted, internal call, so the comparison passes
 * when either principal is absent. Both `bureau.children` and `bureau.goals`
 * answer a denial exactly as they answer a record that is not there, so a
 * caller cannot tell "wrong id" from "not yours".
 */
export function principalAllows(requested: string | undefined, owner: string | undefined): boolean {
  return requested === undefined || owner === undefined || requested === owner;
}
