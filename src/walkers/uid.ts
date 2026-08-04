import { Node } from '../type';
import { walk } from '../walk';

const UID_LENGTH = 4;
const UID_CAPACITY = 26 ** UID_LENGTH;

const toUid = (count: number): string => {
  if (count >= UID_CAPACITY) {
    throw new Error(`SNF node uid overflow: ${count} exceeds capacity ${UID_CAPACITY}`);
  }

  let value = count;
  let uid = '';
  for (let index = 0; index < UID_LENGTH; index++) {
    uid = String.fromCodePoint(97 + (value % 26)) + uid;
    value = Math.floor(value / 26);
  }
  return uid;
};

/** Creates a stateful Node Walker that assigns deterministic four-letter uids. */
export const createAddUid = (): ((root: Node) => Node) => {
  let count = 0;

  return (root) => {
    return walk(root, {
      childKeys: ['children', 'ast'],
      includeRoot: true,
      exchange: (node) => ({
        ...node,
        uid: node.uid ?? toUid(count++),
      }),
    });
  };
};
