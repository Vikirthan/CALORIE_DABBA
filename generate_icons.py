import os
from PIL import Image, ImageDraw, ImageFont

icons_dir = os.path.join(os.path.dirname(__file__), 'public', 'icons')
os.makedirs(icons_dir, exist_ok=True)

def create_icon(size, is_maskable=False):
    # Base background: rich dark slate matching app theme
    bg_color = (22, 38, 42, 255) # #16262a
    img = Image.new('RGBA', (size, size), color=(0, 0, 0, 0) if not is_maskable else bg_color)
    draw = ImageDraw.Draw(img)

    padding = 0 if is_maskable else int(size * 0.05)
    rect_box = [padding, padding, size - padding, size - padding]
    
    # Outer rounded rectangle background
    corner_radius = int(size * 0.22) if not is_maskable else 0
    draw.rounded_rectangle(rect_box, radius=corner_radius, fill=bg_color, outline=(227, 165, 48, 180), width=max(2, int(size * 0.02)))

    # Inner decorative gradient-like circle background for the lunchbox symbol
    center = size // 2
    r = int(size * (0.35 if is_maskable else 0.38))
    draw.ellipse([center - r, center - r, center + r, center + r], fill=(31, 51, 57, 255), outline=(227, 165, 48, 255), width=max(2, int(size * 0.025)))

    # Draw a sleek stylized Bento box lunchbox using vector primitives
    b_w = int(size * 0.38)
    b_h = int(size * 0.34)
    top_left = (center - b_w // 2, center - b_h // 2)
    bottom_right = (center + b_w // 2, center + b_h // 2)
    
    # Outer bento rim
    draw.rounded_rectangle([top_left[0], top_left[1], bottom_right[0], bottom_right[1]], radius=int(size * 0.05), fill=(40, 66, 74, 255), outline=(227, 165, 48, 255), width=max(2, int(size * 0.02)))
    
    # Compartment dividers
    gap = max(2, int(size * 0.015))
    mid_y = top_left[1] + b_h // 2
    mid_x = top_left[0] + b_w // 2
    
    # Top row (Warm Turmeric Gold)
    draw.rounded_rectangle([top_left[0] + gap, top_left[1] + gap, bottom_right[0] - gap, mid_y - gap//2], radius=int(size * 0.02), fill=(227, 165, 48, 255))
    # Bottom left compartment (Cardamom Green)
    draw.rounded_rectangle([top_left[0] + gap, mid_y + gap//2, mid_x - gap//2, bottom_right[1] - gap], radius=int(size * 0.02), fill=(127, 160, 122, 255))
    # Bottom right compartment (Chili Orange)
    draw.rounded_rectangle([mid_x + gap//2, mid_y + gap//2, bottom_right[0] - gap, bottom_right[1] - gap], radius=int(size * 0.02), fill=(193, 97, 58, 255))

    return img

print("Generating PWA Icons...")
create_icon(192).save(os.path.join(icons_dir, 'icon-192.png'))
create_icon(512).save(os.path.join(icons_dir, 'icon-512.png'))
create_icon(180).save(os.path.join(icons_dir, 'apple-touch-icon.png'))
create_icon(512, is_maskable=True).save(os.path.join(icons_dir, 'icon-512-maskable.png'))
print("Icons generated successfully!")
