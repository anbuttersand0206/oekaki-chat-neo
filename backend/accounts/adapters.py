from allauth.core.exceptions import ImmediateHttpResponse
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from django.http import HttpRequest
from django.shortcuts import render


class CustomSocialAccountAdapter(DefaultSocialAccountAdapter):
    """登録済みメールアドレスでの Google SSO 新規登録を拒否するカスタムアダプター。

    デフォルトの allauth は重複���ールがあっても signup フォームへ進み、
    submit 後に初めてエラー���返す。UX とセキュリティのために pre_social_login で
    早期にエラーページへ遷移させ、重複したまま登���フォームが開かれる状態を防ぐ。
    """

    def pre_social_login(self, request: HttpRequest, sociallogin) -> None:
        # is_existing=True は Google アカウントとユーザーが既に紐付いているログインフロー。
        # 登録済みユーザーの正常な���グインをブロックしてはいけない。
        if sociallogin.is_existing:
            return

        # 新規登録フロー：同じメールアドレスが既存アカウントに使われていないか確認する
        if not sociallogin.email_addresses:
            return

        from allauth.account.internal.flows.manage_email import assess_unique_email
        email = sociallogin.email_addresses[0].email
        is_email_unique = assess_unique_email(email)

        # is False（厳密比較）: None（列挙保護モード���と区別するため is を使う
        if is_email_unique is False:
            # メール重複 → signup フ��ームへ進む前にエラーページへ遷移させる
            resp = render(request, 'socialaccount/authentication_error.html', {
                'error_type': 'email_taken',
                'email': email,
            })
            raise ImmediateHttpResponse(resp)
