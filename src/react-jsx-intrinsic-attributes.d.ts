// React consumes `key` before calling a component. It is not an application prop.
// This repository does not install the full React type package, so declare only
// the framework-owned attribute used to reset private editor state on scope changes.
// Keep component props checked; do not add an arbitrary-property index signature.
export {};

declare global {
  namespace JSX {
    interface IntrinsicAttributes {
      key?: string | number | bigint | null;
    }
  }
}
