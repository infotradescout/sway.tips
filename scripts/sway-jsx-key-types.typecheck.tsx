// Compile-only regression coverage. `npm run lint` includes this file; it is not
// imported by the application or its production bundles.
function KeyBoundaryFixture(props: { performerHandle: string; previewMode?: boolean }) {
  return null;
}

export const stringKey = <KeyBoundaryFixture key="performer-a" performerHandle="performer-a" />;
export const numberKey = <KeyBoundaryFixture key={1} performerHandle="performer-a" />;
export const bigintKey = <KeyBoundaryFixture key={1n} performerHandle="performer-a" />;
export const nullKey = <KeyBoundaryFixture key={null} performerHandle="performer-a" />;
export const omittedKey = <KeyBoundaryFixture performerHandle="performer-a" />;

// @ts-expect-error Framework keys do not permit arbitrary objects.
export const invalidKey = <KeyBoundaryFixture key={{ performer: 'a' }} performerHandle="performer-a" />;
// @ts-expect-error Allowing a framework key must not allow unknown component props.
export const unknownProp = <KeyBoundaryFixture key="a" performerHandle="performer-a" unknownProp />;
// @ts-expect-error Framework keys do not replace required component props.
export const missingHandle = <KeyBoundaryFixture key="a" />;
// @ts-expect-error Existing component prop types remain enforced.
export const invalidHandle = <KeyBoundaryFixture key="a" performerHandle={123} />;
