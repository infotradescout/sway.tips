      const bState=useMemo(()=>({activeGigId:statePath?.split('/').at(-1)||null,session:{status:statePath?'active':'inactive',searchScope:'library'},requests:[]}),[statePath]);
      const setBState=useCallback(value=>window.__applied.push(value),[]);
      return {bState,setBState,isLoading:false,roomActionsBlocked:false,roomLookup:{status:statePath?'active':'global',message:null}};
    }`

const cases = [];
const test = (name,run) => cases.push([name,run]);

test('selected-room-memory-contains-only-account-bound-id',async f=>{
  await f.init();
  const roomId='11111111-1111-4111-8111-111111111111';
  await f.select(roomId);
  const key='sway:performer-room-selection:v1:'+JSON.stringify(['owner-A','performer-A']);
  assert.equal(f.w.sessionStorage.getItem(key),roomId);
  assert.equal(f.w.sessionStorage.length,1,'Only one room id is remembered; no private room snapshot is stored.');
});
test('account-switch-restores-only-new-account-remembered-room',async f=>{
  await f.init();
  const roomA='11111111-1111-4111-8111-111111111111';
  const roomB='22222222-2222-4222-8222-222222222222';
  const key=owner=>'sway:performer-room-selection:v1:'+JSON.stringify(['owner-'+owner,'performer-'+owner]);
  await f.select(roomA);
  f.w.sessionStorage.setItem(key('B'),roomB);
  await f.answer(await f.refreshProfile(),{performerProfile:profile('B')});
  assert.equal(f.w.__dash.selectedGigId,roomB);
  assert.equal(f.w.sessionStorage.getItem(key('A')),null,'The previous account selection is cleared.');
  assert.equal(f.w.sessionStorage.getItem(key('B')),roomB);
  assert.equal(f.w.__dash.activeRooms.length,0,'A remembered room is not fabricated as an active registry entry.');
});
