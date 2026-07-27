from pathlib import Path

from app.rag.vector_store import index_folder


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_FOLDER = BASE_DIR / "app" / "data" / "uploaded_docs"


def main():
    index_folder(
        folder_path=str(UPLOAD_FOLDER),
        recreate=True,
        use_llm_metadata=False,
    )

    print("Ingestion complete.")
    print(f"Indexed PDFs from: {UPLOAD_FOLDER}")


if __name__ == "__main__":
    main()
