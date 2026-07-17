import torch
from diffusers import CogVideoXPipeline
from diffusers.utils import export_to_video
import time, os

os.environ["HF_HOME"] = "/media/sdb2/huggingface"

model_id = "THUDM/CogVideoX-2b"
prompt = "A cat walking on a sunny beach"

print(f"Loading {model_id}...")
start = time.time()

pipe = CogVideoXPipeline.from_pretrained(
    model_id,
    torch_dtype=torch.float16,
)

print(f"Model loaded in {time.time()-start:.1f}s")

# Keep everything on CPU initially
pipe = pipe.to("cpu")

print(f"\nGenerating video on CPU + GPU VAE...")
print("This will be slow on 6GB GPU but should not OOM")
start = time.time()

video = pipe(
    prompt=prompt,
    num_inference_steps=25,
    guidance_scale=6,
    num_frames=8,
    height=480,
    width=720,
).frames[0]

gen_time = time.time() - start
print(f"Generated {len(video)} frames in {gen_time/60:.1f} min")

output_path = os.path.join(os.path.dirname(__file__), "output_cogvideox.mp4")
export_to_video(video, output_path)
print(f"Saved to {output_path}")
