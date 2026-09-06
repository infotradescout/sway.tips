      const bState=useMemo(()=>({activeGigId:statePath?.split('/').at(-1)||null,session:{status:statePath?'active':'inactive',searchScope:'library'},requests:[]}),[statePath]);
      const setBState=useCallback(value=>window.__applied.push(value),[]);
      return {bState,setBState,isLoading:false,roomActionsBlocked:false,roomLookup:{status:statePath?'active':'global',message:null}};
    }`

const cases = [];
const test = (name,run) => cases.push([name,run]);
