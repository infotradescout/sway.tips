/** Compile one reviewed relay version into the existing host; never edit server.ts on disk. */
export const legacyPhoneSource='58ceb46de0ab10463dcdd7187985d91d8b4bf45a';
export function bindPhoneSource(source,revision){
 if(typeof source!=='string'||!/^([a-f0-9]{40})$/.test(revision))throw Error('An exact GrindZone source revision is required');
 const marker="'node_modules/.grindzone-phone', '"+legacyPhoneSource+"', 'cloud/shared-host.mjs'";
 if(source.split(marker).length!==2)throw Error('The host relay entry changed; review its source before building');
 return source.replace(marker,"'node_modules/.grindzone-phone', '"+revision+"', 'cloud/shared-host.mjs'");
}
