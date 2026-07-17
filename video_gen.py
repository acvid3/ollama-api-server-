import torch, os, json, sys, time, gc
from diffusers import AnimateDiffPipeline, MotionAdapter, DDIMScheduler
from diffusers.utils import export_to_video
from huggingface_hub import snapshot_download

os.environ["HF_HOME"] = "/media/sdb2/huggingface"
MODEL_DIR = "/media/sdb2/huggingface/models"

def generate_video(prompt, steps=25, output_path=None):
    os.makedirs(MODEL_DIR, exist_ok=True)
    model_id = "emilianJR/epiCRealism"
    motion_id = "guoyww/animatediff-motion-adapter-v1-5-2"

    print(f"Loading SD 1.5 + AnimateDiff...", flush=True)
    start = time.time()

    adapter = MotionAdapter.from_pretrained(
        motion_id,
        torch_dtype=torch.float16,
        cache_dir=MODEL_DIR,
    )

    pipe = AnimateDiffPipeline.from_pretrained(
        model_id,
        motion_adapter=adapter,
        torch_dtype=torch.float16,
        cache_dir=MODEL_DIR,
        safety_checker=None,
    )

    pipe.scheduler = DDIMScheduler.from_pretrained(
        model_id,
        subfolder="scheduler",
        clip_sample=False,
        timestep_spacing="linspace",
        beta_schedule="linear",
        steps_offset=1,
    )

    pipe.enable_vae_slicing()
    pipe.enable_vae_tiling()
    print(f"Model loaded in {time.time()-start:.1f}s", flush=True)

    print(f"Generating video for: '{prompt}'", flush=True)
    gen_start = time.time()

    output = pipe(
        prompt=prompt,
        negative_prompt="bad quality, ugly, blurry, deformed, disfigured, poor details",
        num_frames=16,
        guidance_scale=7.5,
        num_inference_steps=steps,
        generator=torch.Generator("cpu").manual_seed(42),
        height=512,
        width=512,
    )

    frames = output.frames[0]
    gen_time = time.time() - gen_start
    print(f"Generated {len(frames)} frames in {gen_time/60:.1f} min", flush=True)

    if not output_path:
        output_path = os.path.join(os.path.dirname(__file__), "output_video.mp4")
    export_to_video(frames, output_path, fps=8)
    return output_path

if __name__ == "__main__":
    prompt = sys.argv[1] if len(sys.argv) > 1 else "A cat walking on a sunny beach"
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    out = sys.argv[3] if len(sys.argv) > 3 else None

    path = generate_video(prompt, steps, out)
    print(json.dumps({"path": path}))
