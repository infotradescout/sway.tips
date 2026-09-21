/* Test-only virtual MIDI cable. Does not replace Mixxx's mapping or audio engine. */
#include <portmidi.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
static int fd=-1, in_handle, out_handle;
static PmDeviceInfo devs[2]={{1,"SwayTestCable","Sway Free Player",1,0,0},{1,"SwayTestCable","Sway Free Player",0,1,0}};
PmError Pm_Initialize(void){return pmNoError;}
PmError Pm_Terminate(void){if(fd>=0)close(fd);fd=-1;return pmNoError;}
int Pm_CountDevices(void){return 2;}
const PmDeviceInfo *Pm_GetDeviceInfo(PmDeviceID i){return (i>=0&&i<2)?&devs[i]:NULL;}
PmDeviceID Pm_GetDefaultInputDeviceID(void){return 0;}
PmDeviceID Pm_GetDefaultOutputDeviceID(void){return 1;}
PmError Pm_OpenInput(PortMidiStream **s,PmDeviceID id,void* driver,int32_t size,PmTimeProcPtr timer,void* data){
 if(id!=0||fd>=0)return pmInvalidDeviceId;
 fd=socket(AF_INET,SOCK_DGRAM|SOCK_NONBLOCK,0);if(fd<0)return pmHostError;
 struct sockaddr_in a={0};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);a.sin_port=htons(atoi(getenv("SWAY_TEST_MIDI_PORT")));
 if(bind(fd,(void*)&a,sizeof(a))){close(fd);fd=-1;return pmHostError;}
 *s=&in_handle;devs[0].opened=1;fprintf(stderr,"SWAY_VIRTUAL_MIDI_OPEN\n");return pmNoError;
}
PmError Pm_OpenOutput(PortMidiStream **s,PmDeviceID id,void*driver,int32_t size,PmTimeProcPtr timer,void*data,int32_t latency){if(id!=1)return pmInvalidDeviceId;*s=&out_handle;devs[1].opened=1;return pmNoError;}
PmError Pm_Close(PortMidiStream *s){if(s==&in_handle&&fd>=0){close(fd);fd=-1;devs[0].opened=0;}return pmNoError;}
PmError Pm_SetFilter(PortMidiStream*s,int32_t filters){return pmNoError;}
PmError Pm_SetChannelMask(PortMidiStream*s,int mask){return pmNoError;}
PmError Pm_Abort(PortMidiStream*s){return pmNoError;}
int Pm_Read(PortMidiStream*s,PmEvent*b,int32_t n){int k=0;unsigned char p[3];while(k<n&&recv(fd,p,3,MSG_DONTWAIT)==3){struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);b[k].message=Pm_Message(p[0],p[1],p[2]);b[k].timestamp=(PmTimestamp)(ts.tv_sec*1000+ts.tv_nsec/1000000);k++;fprintf(stderr,"SWAY_VIRTUAL_MIDI_RX %u %u %u\n",p[0],p[1],p[2]);}return k;}
PmError Pm_Poll(PortMidiStream*s){unsigned char b;return recv(fd,&b,1,MSG_PEEK|MSG_DONTWAIT)>0?pmGotData:pmNoData;}
PmError Pm_WriteShort(PortMidiStream*s,PmTimestamp when,int32_t msg){return pmNoError;}
PmError Pm_Write(PortMidiStream*s,PmEvent*b,int32_t n){return pmNoError;}
PmError Pm_WriteSysEx(PortMidiStream*s,PmTimestamp when,unsigned char*msg){return pmNoError;}
const char*Pm_GetErrorText(PmError e){return "Sway virtual MIDI cable error";}
int Pm_HasHostError(PortMidiStream*s){return 0;}
void Pm_GetHostErrorText(char*msg,unsigned int len){if(len)msg[0]=0;}
