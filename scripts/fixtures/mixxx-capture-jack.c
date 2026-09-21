/* Owned JACK capture client: records actual Mixxx output, never synthesizes audio. */
#include <jack/jack.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <math.h>
static jack_port_t *ports[2];static FILE *f;static double ss=0,peak=0;static unsigned long long count=0;
static int process(jack_nframes_t n,void *arg){float *l=jack_port_get_buffer(ports[0],n),*r=jack_port_get_buffer(ports[1],n);for(unsigned i=0;i<n;i++){float pair[2]={l[i],r[i]};fwrite(pair,sizeof(float),2,f);ss+=(double)l[i]*l[i]+(double)r[i]*r[i];if(fabs(l[i])>peak)peak=fabs(l[i]);if(fabs(r[i])>peak)peak=fabs(r[i]);count+=2;}return 0;}
int main(int argc,char **argv){if(argc!=3)return 2;jack_status_t status;jack_client_t*c=jack_client_open("sway_observe_audio",JackNoStartServer,&status);if(!c)return 3;f=fopen(argv[1],"wb");if(!f)return 4;ports[0]=jack_port_register(c,"left",JACK_DEFAULT_AUDIO_TYPE,JackPortIsInput,0);ports[1]=jack_port_register(c,"right",JACK_DEFAULT_AUDIO_TYPE,JackPortIsInput,0);jack_set_process_callback(c,process,NULL);if(jack_activate(c))return 5;const char **names=jack_get_ports(c,NULL,JACK_DEFAULT_AUDIO_TYPE,JackPortIsOutput);int linked=0;for(int i=0;names&&names[i]&&linked<2;i++){if(strstr(names[i],"system:")==names[i])continue;fprintf(stderr,"MIXXX_AUDIO_SOURCE %s\n",names[i]);if(!jack_connect(c,names[i],jack_port_name(ports[linked])))linked++;}jack_free(names);if(linked!=2)return 6;usleep((unsigned)(atof(argv[2])*1000000));jack_deactivate(c);fclose(f);printf("{\"sampleRate\":%u,\"samples\":%llu,\"rms\":%.9f,\"peak\":%.9f}\n",jack_get_sample_rate(c),count,sqrt(ss/(count?count:1)),peak);jack_client_close(c);return 0;}
