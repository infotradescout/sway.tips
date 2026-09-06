  './shared': `import React,{useMemo,useCallback} from 'react';
    export const LoadingState=()=>React.createElement('p',null,'Loading');
    export const postJson=(url,body)=>window.__post(url,body);
    export function useSwayState({statePath}) {
      const bState=useMemo(()=>({activeGigId:statePath?.split('/').at(-1)||null,session:{status:statePath?'active':'inactive',searchScope:'library'},requests:[]}),[statePath]);
      const setBState=useCallback(value=>window.__applied.push(value),[]);
      return {bState,setBState,isLoading:false,roomActionsBlocked:false,roomLookup:{status:statePath?'active':'global',message:null}};
    }`
};
for (const name of ['TalentInviteAcceptCard','PerformerRightsReviewQueue','PerformerEventDoorPage','VictoryScreen']) {
  stubs['../components/'+name]='export default ()=>null;';
}
