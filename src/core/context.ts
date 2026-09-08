import { objectSchema, nonempty, stringSchema, validate } from './json.js';
export interface Reference {
  path: string;
  pointer: string;
}
export interface Access extends Reference {
  audience: string[];
}
export function parseAccess(value: unknown): Access[] {
  validate(
    {
      type: 'array',
      items: objectSchema({
        path: nonempty,
        pointer: stringSchema,
        audience: { type: 'array', items: nonempty, minItems: 1, uniqueItems: true },
      }),
    },
    value,
  );
  return value as Access[];
}
/** Intersect author-selected references with explicit character knowledge grants. */
export function actorReferences(
  selected: Reference[],
  grants: Access[],
  character: string,
): Reference[] {
  const refs = selected.flatMap((r) =>
    grants
      .filter(
        (a) =>
          a.path === r.path && (a.audience.includes('public') || a.audience.includes(character)),
      )
      .flatMap((a) => {
        if (a.pointer === r.pointer || r.pointer.startsWith(a.pointer + '/')) return [r];
        if (r.pointer === '' || a.pointer.startsWith(r.pointer + '/'))
          return [{ path: r.path, pointer: a.pointer }];
        return [];
      }),
  );
  return [...new Map(refs.map((r) => [JSON.stringify(r), r])).values()];
}
