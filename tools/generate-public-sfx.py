#!/usr/bin/env python3
"""Original deterministic procedural sounds. No sampled reference audio is read.
Requires Python3, numpy, scipy, ffmpeg. Writes mono44.1kHz MP3/WAV.
"""
from pathlib import Path
import numpy as np
from scipy.signal import butter,sosfilt
import subprocess,json,hashlib
ROOT=Path(__file__).resolve().parent; OUT=ROOT/'sfx';OUT.mkdir(exist_ok=True)
FS=44100
SPEC={'pistol_shot':(1.7,101,110,.20),'rifle_shot':(1.74,102,145,.16),'shotgun_blast':(2.02,103,75,.36),'bullet_casing':(1.43,104,0,0),'headshot_splat':(.48,105,0,0)}
def low(x,hz):return sosfilt(butter(2,hz,fs=FS,output='sos'),x)
def event_noise(rng,t,start,decay,cut):
 age=np.maximum(0,t-start);return low(rng.standard_normal(len(t)),cut)*np.exp(-age/decay)*(t>=start)*(1-np.exp(-age/.0004))
rows=[]
for name,(seconds,seed,freq,decay) in SPEC.items():
 rng=np.random.default_rng(seed);t=np.arange(round(seconds*FS))/FS
 if 'shot' in name and name!='headshot_splat' or name=='shotgun_blast':
  # Broadband pressure crack, low pressure body and independent diffused room returns.
  x=event_noise(rng,t,0,.017,12500)*.55+event_noise(rng,t,0,decay,1500)*.85
  phase=2*np.pi*(freq*t+80*.025*(1-np.exp(-t/.025)))
  x+=.40*np.sin(phase)*np.exp(-t/(decay*.65))*(1-np.exp(-t/.001))
  for delay,amp in [(.028,.28),(.061,.20),(.109,.14),(.173,.09)]:x+=amp*event_noise(rng,t,delay,decay*1.4,2200)
  x+=.035*event_noise(rng,t,.008,.36,4300)
 elif name=='bullet_casing':
  x=np.zeros(len(t))
  for start,amp in [(0,1),(.155,.72),(.282,.51),(.381,.37),(.467,.27),(.532,.18),(.595,.11)]:
   age=np.maximum(0,t-start);env=np.exp(-age/.085)*(t>=start)*(1-np.exp(-age/.00015))
   modes=sum(a*np.sin(2*np.pi*f*age+rng.uniform(-.1,.1)) for f,a in [(2750,.46),(4310,.33),(6830,.19),(9170,.09)])
   x+=amp*(modes*env+.12*event_noise(rng,t,start,.007,11000))
 else:
  # Short bass impact: no firearm crack or wet splatter samples.
  phase=2*np.pi*(68*t+130*.013*(1-np.exp(-t/.013)))
  x=.7*np.sin(phase)*np.exp(-t/.036)*(1-np.exp(-t/.0015))+.30*event_noise(rng,t,0,.024,850)
  x+=.11*event_noise(rng,t,.018,.022,1300)
 x*=np.minimum(1,t/.0005)*np.minimum(1,(seconds-t)/.025)
 x*=.76/max(abs(x));wav=OUT/(name+'.wav');mp3=OUT/(name+'.mp3')
 subprocess.run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(FS),'-ac','1','-i','pipe:0','-c:a','pcm_s16le',str(wav)],input=x.astype('<f4').tobytes(),check=True)
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(wav),'-c:a','libmp3lame','-b:a','192k',str(mp3)],check=True)
 data=subprocess.check_output(['ffmpeg','-v','error','-i',str(mp3),'-f','f32le','-ac','1','-ar',str(FS),'-']);decoded=np.frombuffer(data,'<f4');peak=float(max(abs(decoded)));assert peak<=.82
 rows.append({'cue':name,'file':'sfx/'+mp3.name,'decodedSeconds':len(decoded)/FS,'peak':peak,'seed':seed,'sha256':hashlib.sha256(mp3.read_bytes()).hexdigest(),'provenance':'Original deterministic DSP synthesis; no third-party samples or downloaded references used.'})
(ROOT/'sfx-manifest.json').write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps(rows,indent=2))
