"""Fixture lifecycle and presentation; restatement accounting stays in SQL."""

from __future__ import annotations

import os

import matplotlib.pyplot as plt
import seaborn as sns
from IPython.display import Markdown, display

from synthetic_cost_api import SyntheticCostApi

SOURCE = "Source: synthetic local Cost API · unchanged Git-pinned VGI cost function · Haybarn / VGI"


def configure(lookback_days: int):
    if type(lookback_days) is not int or not 0 <= lookback_days <= 7:
        raise ValueError("LOOKBACK_DAYS must be an integer from 0 through 7 for this fixture")
    fixture = SyntheticCostApi().start()
    previous = os.environ.get("NOTEBOOK_AZURE_COST_FIXTURE_URL")
    os.environ["NOTEBOOK_AZURE_COST_FIXTURE_URL"] = fixture.url
    return fixture, previous


def cleanup(fixture, previous):
    fixture.stop()
    if previous is None:
        os.environ.pop("NOTEBOOK_AZURE_COST_FIXTURE_URL", None)
    else:
        os.environ["NOTEBOOK_AZURE_COST_FIXTURE_URL"] = previous


def prose(text: str) -> None:
    display(Markdown(text))


def theme() -> None:
    sns.set_theme(
        style="whitegrid",
        rc={
            "figure.dpi": 145,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "grid.color": "#E8EDE9",
            "text.color": "#243B2F",
            "axes.labelcolor": "#405047",
            "text.parse_math": False,
            "legend.frameon": False,
        },
    )


def chart(fig, title: str, subtitle: str) -> None:
    fig.text(0.08, 0.98, title, ha="left", va="top", fontsize=17, fontweight="semibold")
    fig.text(0.08, 0.91, subtitle, ha="left", va="top", fontsize=10, color="#58685F")
    fig.tight_layout(rect=(0.02, 0.10, 1, 0.83))
    fig.text(0.08, 0.03, SOURCE, fontsize=8, color="#6C7D73")
    plt.show()
