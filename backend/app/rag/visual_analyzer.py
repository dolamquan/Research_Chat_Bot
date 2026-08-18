import base64
import mimetypes
import uuid
from pathlib import Path
from typing import Any, Dict, List

from dotenv import load_dotenv

from app.storage.visual_assets import create_visual_asset, get_visual_asset_blob_by_ref


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
VISUAL_ASSET_DIR = DATA_DIR / "visual_assets"
UPLOAD_IMAGE_DIR = DATA_DIR / "uploaded_images"
VISION_MODEL = "gpt-4o-mini"


def _image_data_url(image_path: Path) -> str:
    if image_path.exists():
        mime_type = mimetypes.guess_type(image_path.name)[0] or "image/png"
        content = image_path.read_bytes()
    else:
        blob = get_visual_asset_blob_by_ref(str(image_path))
        if blob is None:
            raise FileNotFoundError(f"Image not found: {image_path}")
        mime_type = str(blob["mime_type"])
        content = bytes(blob["content"])

    encoded = base64.b64encode(content).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


def caption_image(
    image_path: Path,
    *,
    context: str = "",
    page: int | None = None,
    llm: Any = None,
) -> str:
    """
    Use a vision-capable model to describe a graph, figure, diagram, or image.

    Falls back to a basic description when no OpenAI key/model is configured.
    """
    load_dotenv()

    try:
        if llm is None:
            from langchain_core.messages import HumanMessage
            from langchain_openai import ChatOpenAI

            llm = ChatOpenAI(model=VISION_MODEL, temperature=0)
            message = HumanMessage(
                content=[
                    {
                        "type": "text",
                        "text": (
                            "Describe this research-paper visual for retrieval. "
                            "If it is a graph, include axes, labels, trends, variables, and the main takeaway. "
                            "If it is a diagram/table/figure, explain the components and relationships. "
                            f"Document context: {context or 'unknown'}."
                            f" Page: {page or 'unknown'}."
                        ),
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": _image_data_url(image_path),
                            "detail": "low",
                        },
                    },
                ]
            )
            response = llm.invoke([message])
        else:
            response = llm.invoke(str(image_path))

        content = getattr(response, "content", str(response)).strip()
        if content:
            return content
    except Exception:
        pass

    location = f" page {page}" if page else ""
    return (
        f"Visual asset extracted from {context or image_path.name}{location}. "
        "No vision caption was generated."
    )


def transcribe_formula_image(
    image_path: Path,
    *,
    context: str = "",
    page: int | None = None,
    llm: Any = None,
) -> str:
    """
    Convert a selected equation image into Markdown with display LaTeX.
    """
    load_dotenv()

    try:
        from langchain_core.messages import HumanMessage

        if llm is None:
            from langchain_openai import ChatOpenAI

            llm = ChatOpenAI(model=VISION_MODEL, temperature=0)

        message = HumanMessage(
            content=[
                {
                    "type": "text",
                    "text": (
                        "Transcribe the mathematical equation in this research-paper image. "
                        "Return the answer as Markdown. Put the equation in a single display "
                        "LaTeX block delimited with $$ ... $$. After the equation, add at most "
                        "three concise bullet points explaining the symbols only if they are "
                        "visible or strongly implied by the image/context. Do not invent "
                        "unsupported definitions. "
                        f"Document context: {context or 'unknown'}. "
                        f"Page: {page or 'unknown'}."
                    ),
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": _image_data_url(image_path),
                        "detail": "high",
                    },
                },
            ]
        )
        response = llm.invoke([message])

        content = getattr(response, "content", str(response)).strip()
        if content:
            return content
    except Exception:
        pass

    return (
        "I could not transcribe this equation image automatically. "
        "Try capturing a tighter crop around just the formula."
    )


def _safe_stem(value: str) -> str:
    return "".join(char if char.isalnum() or char in "-_" else "_" for char in value)[:90]


def _decode_image_data(image_data: str) -> bytes:
    if "," in image_data and image_data.lower().startswith("data:"):
        image_data = image_data.split(",", 1)[1]

    try:
        return base64.b64decode(image_data, validate=True)
    except Exception as exc:
        raise ValueError("Invalid image data.") from exc


def save_uploaded_image(
    *,
    filename: str,
    content: bytes,
    title: str = "",
    domain: str = "research",
    category: str = "uncategorized",
) -> Dict[str, Any]:
    suffix = Path(filename).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("Only PNG, JPG, JPEG, and WEBP images are supported.")

    UPLOAD_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = f"{_safe_stem(Path(filename).stem)}{suffix}"
    image_path = UPLOAD_IMAGE_DIR / safe_name
    counter = 1

    while image_path.exists():
        image_path = UPLOAD_IMAGE_DIR / f"{_safe_stem(Path(filename).stem)}_{counter}{suffix}"
        counter += 1

    image_path.write_bytes(content)
    try:
        caption = caption_image(
            image_path,
            context=title or safe_name,
        )

        return create_visual_asset(
            source=safe_name,
            title=title or Path(filename).stem,
            image_path=str(image_path),
            image_url=f"/visuals/{image_path.name}/image",
            caption=caption,
            image_bytes=content,
            mime_type=mimetypes.guess_type(image_path.name)[0] or "image/png",
            asset_type="uploaded_image",
        ) | {
            "domain": domain,
            "category": category,
        }
    finally:
        if image_path.exists():
            image_path.unlink()


def save_captured_pdf_visual(
    *,
    source: str,
    image_data: str,
    article_id: str = "",
    title: str = "",
    page: int | None = None,
    caption: str = "",
) -> Dict[str, Any]:
    """
    Save a user-cropped PDF region as a visual asset.

    This is for manually capturing figures/graphs from the rendered PDF canvas,
    instead of extracting every embedded image in the document.
    """
    image_bytes = _decode_image_data(image_data)
    if not image_bytes:
        raise ValueError("Empty image data.")

    VISUAL_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    page_label = f"p{page}" if page else "page"
    output_name = (
        f"{_safe_stem(Path(source).stem)}_{page_label}_capture_{uuid.uuid4().hex[:10]}.png"
    )
    output_path = VISUAL_ASSET_DIR / output_name
    output_path.write_bytes(image_bytes)
    try:
        context = title or Path(source).stem.replace("_", " ")
        generated_caption = caption_image(
            output_path,
            context=caption or context,
            page=page,
        )

        return create_visual_asset(
            source=source,
            article_id=article_id,
            title=title or context,
            page=page,
            image_path=str(output_path),
            image_url=f"/visuals/{output_name}/image",
            caption=generated_caption,
            image_bytes=image_bytes,
            mime_type="image/png",
            asset_type="pdf_region",
        )
    finally:
        if output_path.exists():
            output_path.unlink()


def extract_pdf_visuals(
    pdf_path: Path,
    *,
    source: str | None = None,
    article_metadata: Dict[str, Any] | None = None,
    max_images: int = 20,
) -> List[Dict[str, Any]]:
    """
    Extract embedded raster images from a PDF, caption them, and persist records.
    """
    try:
        import fitz
    except Exception:
        return []

    source_name = source or pdf_path.name
    metadata = article_metadata or {}
    VISUAL_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    saved_assets: List[Dict[str, Any]] = []

    doc = fitz.open(str(pdf_path))
    try:
        for page_index in range(len(doc)):
            if len(saved_assets) >= max_images:
                break

            page = doc[page_index]
            for image_index, image in enumerate(page.get_images(full=True), start=1):
                if len(saved_assets) >= max_images:
                    break

                xref = image[0]
                image_data = doc.extract_image(xref)
                image_bytes = image_data.get("image")
                extension = image_data.get("ext", "png")

                if not image_bytes:
                    continue

                output_name = (
                    f"{_safe_stem(Path(source_name).stem)}"
                    f"_p{page_index + 1}_{image_index}.{extension}"
                )
                output_path = VISUAL_ASSET_DIR / output_name
                output_path.write_bytes(image_bytes)
                try:
                    caption = caption_image(
                        output_path,
                        context=metadata.get("title") or source_name,
                        page=page_index + 1,
                    )
                    asset = create_visual_asset(
                        source=source_name,
                        article_id=str(metadata.get("article_id", "")),
                        title=str(metadata.get("title", "")),
                        page=page_index + 1,
                        image_path=str(output_path),
                        image_url=f"/visuals/{output_name}/image",
                        caption=caption,
                        image_bytes=image_bytes,
                        mime_type=mimetypes.guess_type(output_name)[0] or "image/png",
                        asset_type="pdf_image",
                    )
                finally:
                    if output_path.exists():
                        output_path.unlink()
                saved_assets.append(asset)
    finally:
        doc.close()

    return saved_assets
