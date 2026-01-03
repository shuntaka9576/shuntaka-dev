pub mod health;
pub mod users_articles;
pub mod webhooks;

use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::ApiDoc;

pub fn build_swagger_router() -> SwaggerUi {
    SwaggerUi::new("/swagger").url("/swagger/openapi.json", ApiDoc::openapi())
}
