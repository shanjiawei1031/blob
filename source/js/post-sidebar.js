// Add page-type class to body
function detectPageType() {
    var isPost = document.querySelector('article.article');
    var hasArticleTags = document.querySelector('.article-tags');
    var hasPostNav = document.querySelector('.post-navigation');
    if (isPost && (hasArticleTags || hasPostNav || document.querySelector('.article-licensing'))) {
        document.body.classList.add('post-page');
        document.body.classList.remove('home-page');
    } else if (isPost) {
        // Index page — articles but no tags/nav
        document.body.classList.add('home-page');
        document.body.classList.remove('post-page');
    } else {
        document.body.classList.remove('post-page');
        document.body.classList.remove('home-page');
    }
}

document.addEventListener('DOMContentLoaded', function () {
    detectPageType();
});

document.addEventListener('pjax:success', function () {
    detectPageType();
});
