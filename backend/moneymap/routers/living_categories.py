import unicodedata

from fastapi import APIRouter, Depends, Path, Request
from pydantic import BaseModel, field_validator

from moneymap.adapters.sqlite.living_categories import catalog, save_name
from moneymap.dependencies import request_connection

router = APIRouter(prefix="/api/living-categories", dependencies=[Depends(request_connection)])


class CategoryName(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        name = unicodedata.normalize("NFC", value).strip()
        if not 1 <= len(name) <= 50 or name == "미분류":
            raise ValueError("미분류 이외의 이름을 1~50자로 입력하세요")
        return name


@router.get("")
def list_categories(request: Request):
    return catalog(request.state.conn)


@router.post("", status_code=201)
def create_category(body: CategoryName, request: Request):
    return save_name(request.state.conn, body.name)


@router.put("/{category_id}")
def rename_category(body: CategoryName, request: Request, category_id: int = Path(gt=0, le=2**53-1)):
    return save_name(request.state.conn, body.name, category_id)
