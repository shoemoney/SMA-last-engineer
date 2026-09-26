"""Original DSP candidate. No reference recording samples used. Python standard library."""
import math, random, wave, struct
from pathlib import Path
rng = random.Random(51027)
rate = 48000
n = int(.278 * rate)
samples = []
low = 0.
for i in range(n):
    t = i / rate
    noise = rng.uniform(-1, 1)
    low += .15 * (noise - low)
    body = math.sin(2 * math.pi * (170*t - 95*t*t)) * math.exp(-t/.032)
    hiss = (noise-low) * math.exp(-t/.012)
    puff = low * math.exp(-t/.058)
    click = math.sin(2*math.pi*1800*t) * math.exp(-t/.003)
    slide = (noise-low)*math.exp(-(t-.043)/.006) if t >= .043 else 0
    x = (.5*body + .24*puff + .085*hiss + .09*click + .04*slide)
    samples.append(x * min(1, t/.0005) * min(1, max(0, (.278-t)/.03)))
peak = max(map(abs, samples))
with wave.open(str(Path(__file__).with_name('pistol_suppressed-original.wav')), 'wb') as w:
    w.setparams((1, 2, rate, n, 'NONE', 'not compressed'))
    w.writeframes(b''.join(struct.pack('<h', int(x*.7/peak*32767)) for x in samples))
